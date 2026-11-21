import type { ChangeEvent } from "./types.ts";

/** Editorial roles an item can play in an issue, in the order they render. */
export const SECTION_ORDER = ["lead", "shipped", "watch", "voices"] as const;

export type Section = (typeof SECTION_ORDER)[number];

/** Presentation labels shared by every renderer of an issue. */
export const SECTION_LABELS: Record<Section, string> = {
  lead: "Lead",
  shipped: "Shipped",
  watch: "Worth watching",
  voices: "Voices",
};

/**
 * The section `issue open` pre-assigns. Section is structure, not voice: the
 * operator edits an opinionated draft instead of classifying from a blank
 * slate. `isTop` marks the first item of the ordered pre-fill, which leads.
 */
export const sectionFor = (event: Pick<ChangeEvent, "type">, isTop: boolean): Section => {
  if (isTop) return "lead";
  switch (event.type) {
    case "editorial":
      return "voices";
    case "baseline-change":
    case "browser-support":
    case "browser-release":
    case "runtime-release":
      return "shipped";
    case "spec-change":
    case "vendor-position":
    case "feature-status":
    case "tag-review":
      return "watch";
  }
};

export interface SectionGroup<T> {
  section: Section;
  items: T[];
}

/**
 * Groups items by section in `SECTION_ORDER`, keeping the input order inside a
 * section. Sections with no items are omitted, so a renderer never prints an
 * empty heading.
 */
export const groupBySection = <T extends { section: Section }>(items: T[]): SectionGroup<T>[] =>
  SECTION_ORDER.map((section) => ({
    section,
    items: items.filter((item) => item.section === section),
  })).filter((group) => group.items.length > 0);

/**
 * The warning that separates an issue from a changelog: there is at least one
 * included item and none of them carries a note. Excluded items never count,
 * because they are never rendered, and an issue with no items has nothing to
 * annotate.
 */
export const isUnannotated = (items: { included: boolean; note: string | null }[]): boolean => {
  const included = items.filter((item) => item.included);
  return included.length > 0 && included.every((item) => (item.note ?? "").trim() === "");
};
