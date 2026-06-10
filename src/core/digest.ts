import type { ChangeEvent } from "./types.ts";

/** A digest as consumers see it: the reader and the email channel render this. */
export interface DigestView {
  id: string;
  windowStart: string;
  windowEnd: string;
  cadence: string;
  items: ChangeEvent[];
}

/** Theme order for presentation: platform work first, runtimes last. */
const THEME_ORDER = ["css", "html", "javascript", "api", "runtime"];

const theme = (event: ChangeEvent): string => event.taxonomy[0] ?? "api";

const themeRank = (event: ChangeEvent): number => {
  const rank = THEME_ORDER.indexOf(theme(event));
  return rank === -1 ? THEME_ORDER.length : rank;
};

/**
 * Digest assembly ordering (§9): group by theme, rank by significance
 * within a group, with a stable tiebreak so assembly is deterministic.
 */
export const orderForDigest = (events: ChangeEvent[]): ChangeEvent[] =>
  [...events].sort(
    (a, b) =>
      themeRank(a) - themeRank(b) ||
      b.significance - a.significance ||
      a.title.localeCompare(b.title),
  );
