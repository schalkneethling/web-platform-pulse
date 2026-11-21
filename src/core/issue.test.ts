import { describe, expect, it } from "vite-plus/test";
import type { ChangeEventType } from "./types.ts";
import {
  groupBySection,
  isUnannotated,
  SECTION_LABELS,
  SECTION_ORDER,
  sectionFor,
  type Section,
} from "./issue.ts";

describe("sectionFor", () => {
  it("makes the top item the lead whatever its type", () => {
    expect(sectionFor({ type: "editorial" }, true)).toBe("lead");
    expect(sectionFor({ type: "spec-change" }, true)).toBe("lead");
  });

  it.each<[ChangeEventType, Section]>([
    ["editorial", "voices"],
    ["baseline-change", "shipped"],
    ["browser-support", "shipped"],
    ["browser-release", "shipped"],
    ["runtime-release", "shipped"],
    ["spec-change", "watch"],
    ["vendor-position", "watch"],
    ["feature-status", "watch"],
    ["tag-review", "watch"],
  ])("assigns %s to %s when it is not the top item", (type, section) => {
    expect(sectionFor({ type }, false)).toBe(section);
  });
});

describe("SECTION_LABELS", () => {
  it("labels every section in the order list", () => {
    expect(Object.keys(SECTION_LABELS).sort()).toEqual([...SECTION_ORDER].sort());
  });
});

describe("groupBySection", () => {
  it("orders groups by SECTION_ORDER and keeps input order within a group", () => {
    const items: { id: string; section: Section }[] = [
      { id: "a", section: "voices" },
      { id: "b", section: "watch" },
      { id: "c", section: "lead" },
      { id: "d", section: "watch" },
    ];
    expect(groupBySection(items)).toEqual([
      { section: "lead", items: [items[2]] },
      { section: "watch", items: [items[1], items[3]] },
      { section: "voices", items: [items[0]] },
    ]);
  });

  it("omits empty sections and returns nothing for no items", () => {
    expect(groupBySection([])).toEqual([]);
  });
});

describe("isUnannotated", () => {
  it("is true when every included item has a null or blank note", () => {
    expect(
      isUnannotated([
        { included: true, note: null },
        { included: true, note: "  " },
      ]),
    ).toBe(true);
  });

  it("is false as soon as one included item has a note", () => {
    expect(
      isUnannotated([
        { included: true, note: null },
        { included: true, note: "Why this matters." },
      ]),
    ).toBe(false);
  });

  it("ignores excluded items, even annotated ones", () => {
    expect(
      isUnannotated([
        { included: true, note: null },
        { included: false, note: "Cut from the issue." },
      ]),
    ).toBe(true);
  });

  it("is false when nothing is included", () => {
    expect(isUnannotated([])).toBe(false);
    expect(isUnannotated([{ included: false, note: null }])).toBe(false);
  });
});
