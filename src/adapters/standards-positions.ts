import type { SourceAdapter } from "../core/adapter.ts";
import {
  derivePositionIndex,
  diffVendorPositions,
  type PositionIndex,
  type VendorPosition,
} from "../core/standards-positions/diff.ts";
import { fetchJson } from "./http.ts";

export const STANDARDS_POSITIONS_SOURCE_ID = "standards-positions";

/** The published artifacts this differ observes (§5.3), one per vendor. */
export const MOZILLA_POSITIONS_URL =
  "https://raw.githubusercontent.com/mozilla/standards-positions/gh-pages/merged-data.json";
export const WEBKIT_POSITIONS_URL =
  "https://raw.githubusercontent.com/WebKit/standards-positions/main/summary.json";

interface MozillaEntry {
  position?: unknown;
  title?: unknown;
  url?: unknown;
  topics?: unknown;
}

/** merged-data.json is keyed by the standards-positions issue number. */
export const parseMozillaPositions = (payload: Record<string, MozillaEntry>): VendorPosition[] => {
  const positions: VendorPosition[] = [];
  for (const [key, entry] of Object.entries(payload)) {
    if (typeof entry.title !== "string" || entry.title === "") continue;
    positions.push({
      vendor: "mozilla",
      key,
      position: typeof entry.position === "string" ? entry.position : null,
      title: entry.title,
      specUrl: typeof entry.url === "string" ? entry.url : null,
      issueUrl: `https://github.com/mozilla/standards-positions/issues/${key}`,
      topics: Array.isArray(entry.topics) ? entry.topics.filter((t) => typeof t === "string") : [],
    });
  }
  return positions;
};

interface WebKitEntry {
  id?: unknown;
  position?: unknown;
  title?: unknown;
  url?: unknown;
  topics?: unknown;
}

/** summary.json is an array; `id` is the issue URL, its tail the number. */
export const parseWebKitPositions = (payload: WebKitEntry[]): VendorPosition[] => {
  const positions: VendorPosition[] = [];
  for (const entry of payload) {
    if (typeof entry.id !== "string" || typeof entry.title !== "string" || entry.title === "") {
      continue;
    }
    const key = entry.id.split("/").at(-1);
    if (!key) continue;
    positions.push({
      vendor: "webkit",
      key,
      position: typeof entry.position === "string" ? entry.position : null,
      title: entry.title,
      specUrl: typeof entry.url === "string" ? entry.url : null,
      issueUrl: entry.id,
      topics: Array.isArray(entry.topics) ? entry.topics.filter((t) => typeof t === "string") : [],
    });
  }
  return positions;
};

export const fetchVendorPositions = async (): Promise<VendorPosition[]> => {
  const [mozilla, webkit] = await Promise.all([
    fetchJson<Record<string, MozillaEntry>>(MOZILLA_POSITIONS_URL).then(parseMozillaPositions),
    fetchJson<WebKitEntry[]>(WEBKIT_POSITIONS_URL).then(parseWebKitPositions),
  ]);
  return [...mozilla, ...webkit];
};

export interface StandardsPositionsAdapterOptions {
  fetchPositions: () => Promise<VendorPosition[]>;
  now?: () => Date;
}

export const createStandardsPositionsAdapter = (
  options: StandardsPositionsAdapterOptions,
): SourceAdapter<PositionIndex> => {
  const now = options.now ?? (() => new Date());
  return {
    sourceId: STANDARDS_POSITIONS_SOURCE_ID,
    kind: "artifact-diff",
    run: async (cursor) => {
      const positions = await options.fetchPositions();
      const events = diffVendorPositions(cursor, positions, {
        observedAt: now().toISOString(),
      });
      // The cursor only advances for proposals this run observed, so a
      // vendor artifact that omits an entry cannot erase its memory.
      return { events, cursor: { ...cursor, ...derivePositionIndex(positions) } };
    },
  };
};
