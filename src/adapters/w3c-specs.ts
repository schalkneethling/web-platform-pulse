import type { SourceAdapter } from "../core/adapter.ts";
import {
  deriveW3CSpecIndex,
  diffW3CSpecs,
  type W3CSpec,
  type W3CSpecIndex,
} from "../core/w3c-specs/diff.ts";
import { fetchWithTimeout } from "./http.ts";

export const W3C_SPECS_SOURCE_ID = "w3c-specs";

/** The allowlist this differ observes (§5.3): no bulk W3C artifact exists. */
export const BROWSER_SPECS_INDEX_URL =
  "https://raw.githubusercontent.com/w3c/browser-specs/main/index.json";
export const W3C_API_BASE = "https://api.w3.org";

/** Bounded concurrency: ~600 specs, one at a time would be slow, all at
 * once would hammer api.w3.org. */
const CONCURRENCY = 10;

interface BrowserSpecsGroup {
  name?: unknown;
}

interface BrowserSpecsEntry {
  shortname?: unknown;
  title?: unknown;
  organization?: unknown;
  release?: { url?: unknown };
  groups?: BrowserSpecsGroup[];
}

export interface W3CRecTrackSpec {
  shortname: string;
  title: string;
  groups: string[];
}

/**
 * browser-specs entries carry a `release` object only when the spec has an
 * actual /TR/ publication (rec-track); nightly-only drafts omit it. That,
 * plus `organization === "W3C"`, is the allowlist filter (§ Slice A).
 */
export const parseW3CRecTrackSpecs = (payload: BrowserSpecsEntry[]): W3CRecTrackSpec[] => {
  const specs: W3CRecTrackSpec[] = [];
  for (const entry of payload) {
    if (entry.organization !== "W3C") continue;
    if (!entry.release) continue;
    if (typeof entry.shortname !== "string" || typeof entry.title !== "string") continue;
    const groups = (entry.groups ?? [])
      .map((group) => group.name)
      .filter((name): name is string => typeof name === "string");
    specs.push({ shortname: entry.shortname, title: entry.title, groups });
  }
  return specs;
};

const fetchJson = async <T>(url: string): Promise<T> => {
  const response = await fetchWithTimeout(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`${url} fetch failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
};

export const fetchW3CRecTrackSpecs = async (): Promise<W3CRecTrackSpec[]> =>
  parseW3CRecTrackSpecs(await fetchJson<BrowserSpecsEntry[]>(BROWSER_SPECS_INDEX_URL));

interface W3CVersionLinks {
  editors?: { href?: unknown };
  deliverers?: { href?: unknown };
}

interface W3CVersionResponse {
  status?: unknown;
  date?: unknown;
  uri?: unknown;
  _links?: W3CVersionLinks;
}

interface W3CLinkedEntity {
  title?: unknown;
}

interface W3CLinkedListResponse {
  _links?: {
    editors?: W3CLinkedEntity[];
    deliverers?: W3CLinkedEntity[];
  };
}

const namesOf = (entities: W3CLinkedEntity[] | undefined): string[] =>
  (entities ?? [])
    .map((entity) => entity.title)
    .filter((title): title is string => typeof title === "string");

/**
 * One spec's latest version plus its editors and working groups — three
 * requests, since api.w3.org links them as separate paginated resources
 * rather than embedding them (§ Slice A investigation).
 */
export const fetchW3CSpec = async (spec: W3CRecTrackSpec): Promise<W3CSpec | null> => {
  const versionUrl = `${W3C_API_BASE}/specifications/${spec.shortname}/versions/latest`;
  const response = await fetchWithTimeout(versionUrl, {
    headers: { Accept: "application/json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`${versionUrl} fetch failed: ${response.status} ${response.statusText}`);
  }
  const version = (await response.json()) as W3CVersionResponse;
  if (typeof version.status !== "string") return null;

  const editorsHref = version._links?.editors?.href;
  const deliverersHref = version._links?.deliverers?.href;
  const [editorsPage, deliverersPage] = await Promise.all([
    typeof editorsHref === "string" ? fetchJson<W3CLinkedListResponse>(editorsHref) : null,
    typeof deliverersHref === "string" ? fetchJson<W3CLinkedListResponse>(deliverersHref) : null,
  ]);

  const editors = namesOf(editorsPage?._links?.editors);
  const deliverers = namesOf(deliverersPage?._links?.deliverers);

  return {
    shortname: spec.shortname,
    title: spec.title,
    status: version.status,
    date: typeof version.date === "string" ? version.date : null,
    url: typeof version.uri === "string" ? version.uri : `https://www.w3.org/TR/${spec.shortname}/`,
    groups: deliverers.length > 0 ? deliverers : spec.groups,
    editors,
  };
};

/** Runs `fn` over `items` with at most `limit` in flight at once. */
const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = Array.from({ length: items.length });
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

/**
 * Fetches the allowlist, then each spec's latest version. A single spec's
 * request failing (network blip, transient 5xx) must not abort the run for
 * the other ~600 — log and skip it, same spirit as a source being retried
 * from its cursor next run, but at per-spec granularity (§ chrome-status
 * analog for defensive external-API fetching).
 */
export const fetchW3CSpecs = async (): Promise<W3CSpec[]> => {
  const recTrackSpecs = await fetchW3CRecTrackSpecs();
  const results = await mapWithConcurrency(recTrackSpecs, CONCURRENCY, async (spec) => {
    try {
      return await fetchW3CSpec(spec);
    } catch (error) {
      console.warn(`w3c-specs: skipping ${spec.shortname}: ${(error as Error).message}`);
      return null;
    }
  });
  return results.filter((spec): spec is W3CSpec => spec !== null);
};

export interface W3CSpecsAdapterOptions {
  fetchSpecs: () => Promise<W3CSpec[]>;
  now?: () => Date;
}

export const createW3CSpecsAdapter = (
  options: W3CSpecsAdapterOptions,
): SourceAdapter<W3CSpecIndex> => {
  const now = options.now ?? (() => new Date());
  return {
    sourceId: W3C_SPECS_SOURCE_ID,
    kind: "artifact-diff",
    run: async (cursor) => {
      const specs = await options.fetchSpecs();
      const events = diffW3CSpecs(cursor, specs, { observedAt: now().toISOString() });
      // The cursor only advances for specs this run observed, so a spec
      // request that failed and was skipped cannot erase its memory.
      return { events, cursor: { ...cursor, ...deriveW3CSpecIndex(specs) } };
    },
  };
};
