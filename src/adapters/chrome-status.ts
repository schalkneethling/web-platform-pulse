import type { SourceAdapter } from "../core/adapter.ts";
import {
  deriveChromeStatusIndex,
  diffChromeStatus,
  type ChromeFeature,
  type ChromeStatusIndex,
} from "../core/chrome-status/diff.ts";

export const CHROME_STATUS_SOURCE_ID = "chrome-status";

/** The published artifact this differ observes (§5.3), paginated. */
export const CHROME_STATUS_FEATURES_URL = "https://chromestatus.com/api/v0/features";

const PAGE_SIZE = 500;
/** 3,454 features fit in 7 pages today; the cap bounds a runaway loop. */
const MAX_PAGES = 20;

interface ChromeStatusEntry {
  id?: unknown;
  name?: unknown;
  deleted?: unknown;
  confidential?: unknown;
  category?: unknown;
  web_feature?: unknown;
  standards?: { spec?: unknown };
  browsers?: { chrome?: { status?: { text?: unknown; milestone_str?: unknown } } };
}

interface ChromeStatusPage {
  total_count?: unknown;
  features?: ChromeStatusEntry[];
}

/** For unreleased features milestone_str echoes the status text. */
const milestoneOf = (status: { milestone_str?: unknown } | undefined): string | null => {
  const raw = status?.milestone_str;
  return typeof raw === "string" && /^\d+$/.test(raw) ? raw : null;
};

export const parseChromeFeatures = (payload: ChromeStatusPage): ChromeFeature[] => {
  const features: ChromeFeature[] = [];
  for (const entry of payload.features ?? []) {
    if (entry.deleted === true || entry.confidential === true) continue;
    if (typeof entry.id !== "number" || typeof entry.name !== "string") continue;
    const status = entry.browsers?.chrome?.status;
    if (typeof status?.text !== "string") continue;
    features.push({
      id: String(entry.id),
      name: entry.name,
      status: status.text,
      milestone: milestoneOf(status),
      webFeature: typeof entry.web_feature === "string" ? entry.web_feature : null,
      specUrl: typeof entry.standards?.spec === "string" ? entry.standards.spec : null,
      category: typeof entry.category === "string" ? entry.category : "",
    });
  }
  return features;
};

/** chromestatus prepends the XSSI guard `)]}'` to every JSON response. */
const stripXssiPrefix = (body: string): string => {
  const newline = body.indexOf("\n");
  return body.startsWith(")]}'") && newline !== -1 ? body.slice(newline + 1) : body;
};

const fetchPage = async (start: number): Promise<ChromeStatusPage> => {
  const url = `${CHROME_STATUS_FEATURES_URL}?num=${PAGE_SIZE}&start=${start}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} fetch failed: ${response.status} ${response.statusText}`);
  }
  return JSON.parse(stripXssiPrefix(await response.text())) as ChromeStatusPage;
};

export const fetchChromeFeatures = async (): Promise<ChromeFeature[]> => {
  const features: ChromeFeature[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = await fetchPage(page * PAGE_SIZE);
    const batch = payload.features ?? [];
    features.push(...parseChromeFeatures(payload));
    // A short page always ends the dump; total_count only ends it when
    // present, so an omitted count falls back to page-size probing.
    if (batch.length < PAGE_SIZE) return features;
    const total = payload.total_count;
    if (typeof total === "number" && (page + 1) * PAGE_SIZE >= total) return features;
  }
  // Truncation is survivable — the cursor only advances for observed
  // features — but it should not be silent.
  console.warn(`chrome-status: dump still full after ${MAX_PAGES} pages; results truncated`);
  return features;
};

export interface ChromeStatusAdapterOptions {
  fetchFeatures: () => Promise<ChromeFeature[]>;
  now?: () => Date;
}

export const createChromeStatusAdapter = (
  options: ChromeStatusAdapterOptions,
): SourceAdapter<ChromeStatusIndex> => {
  const now = options.now ?? (() => new Date());
  return {
    sourceId: CHROME_STATUS_SOURCE_ID,
    kind: "artifact-diff",
    run: async (cursor) => {
      const features = await options.fetchFeatures();
      const events = diffChromeStatus(cursor, features, {
        observedAt: now().toISOString(),
      });
      // The cursor only advances for features this run observed, so a
      // truncated dump cannot erase another feature's memory.
      return { events, cursor: { ...cursor, ...deriveChromeStatusIndex(features) } };
    },
  };
};
