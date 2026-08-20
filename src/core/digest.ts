import { splitBrowserSupport, type SupportRollup } from "./support-rollup.ts";
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

/** Per-theme cap on rendered units, shared by every renderer. */
export const THEME_ITEM_CAP = 5;

/**
 * A single rendered unit within a theme section: either a plain change event
 * or a browser-support rollup (which itself may fold several events into one
 * sentence). Renderers work in units, not raw events — capping raw events
 * could truncate a rollup mid-way and render a misleading partial sentence.
 */
export type ThemeUnit =
  | { kind: "event"; key: string; event: ChangeEvent }
  | { kind: "rollup"; key: string; rollup: SupportRollup };

export interface CappedTheme {
  visible: ThemeUnit[];
  hidden: ThemeUnit[];
}

/**
 * Splits a theme group's items into rendered units in the exact order
 * today's renderers already produce: `rest` (untouched events) first, then
 * rollups. `key` matches the React keys the reader already uses (`item.id`,
 * `rollup.lead`) so it does not have to duplicate key logic.
 */
export const themeUnits = (items: ChangeEvent[]): ThemeUnit[] => {
  const { rest, rollups } = splitBrowserSupport(items);
  return [
    ...rest.map((event): ThemeUnit => ({ kind: "event", key: event.id, event })),
    ...rollups.map((rollup): ThemeUnit => ({ kind: "rollup", key: rollup.lead, rollup })),
  ];
};

/**
 * Caps a theme group's plain events at `THEME_ITEM_CAP`. Rollups are exempt
 * and always render: a rollup is already the compressed form of many events,
 * so folding it away would hide the densest line in the section to save one
 * sentence. The cap exists to bound a long list of individual items, and a
 * rollup is the opposite of that.
 *
 * `hidden` carries the folded units themselves rather than a count, so the
 * reader can reveal them; the email renderer needs only `hidden.length`.
 */
export const capThemeGroup = (group: ThemeGroup): CappedTheme => {
  const units = themeUnits(group.items);
  const events = units.filter((unit) => unit.kind === "event");
  const rollups = units.filter((unit) => unit.kind === "rollup");
  return {
    // Events before rollups, matching the order themeUnits already produces.
    visible: [...events.slice(0, THEME_ITEM_CAP), ...rollups],
    hidden: events.slice(THEME_ITEM_CAP),
  };
};
