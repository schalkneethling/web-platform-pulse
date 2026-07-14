import type { ChangeEvent } from "./types.ts";

/** A digest as consumers see it: the reader and the email channel render this. */
export interface DigestView {
  id: string;
  windowStart: string;
  windowEnd: string;
  cadence: string;
  items: ChangeEvent[];
}

/** Theme order for presentation: platform work first, browsers and runtimes
 * after, commentary (Voices) closing the digest. */
const THEME_ORDER = ["css", "html", "javascript", "api", "browser", "runtime", "voices"];

/** Presentation labels shared by every renderer of a digest. */
export const THEME_LABELS: Record<string, string> = {
  css: "CSS",
  html: "HTML",
  javascript: "JavaScript",
  api: "Web APIs",
  browser: "Browser Releases",
  runtime: "Runtimes",
  voices: "Voices",
};

export const themeOf = (event: ChangeEvent): string => event.taxonomy[0] ?? "api";

const themeRank = (event: ChangeEvent): number => {
  const rank = THEME_ORDER.indexOf(themeOf(event));
  return rank === -1 ? THEME_ORDER.length : rank;
};

export interface ThemeGroup {
  theme: string;
  items: ChangeEvent[];
}

/** Items arrive in presentation order (§9); grouping is by consecutive theme. */
export const groupByTheme = (items: ChangeEvent[]): ThemeGroup[] => {
  const groups: ThemeGroup[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last && last.theme === themeOf(item)) {
      last.items.push(item);
    } else {
      groups.push({ theme: themeOf(item), items: [item] });
    }
  }
  return groups;
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
