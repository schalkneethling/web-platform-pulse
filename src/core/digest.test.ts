import { describe, expect, it } from "vite-plus/test";
import { capThemeGroup, orderForDigest, THEME_ITEM_CAP, themeUnits } from "./digest.ts";
import type { ChangeEvent } from "./types.ts";

const event = (id: string, overrides: Partial<ChangeEvent>): ChangeEvent => ({
  id,
  type: "baseline-change",
  subject: { kind: "feature", id },
  title: id,
  before: null,
  after: { baseline: "low" },
  occurredAt: null,
  taxonomy: ["css"],
  dedupeKey: `k:${id}`,
  correlationKey: `c:${id}`,
  provenance: [],
  significance: 0.5,
  firstObservedAt: "2026-06-10T00:00:00Z",
  lastUpdatedAt: "2026-06-10T00:00:00Z",
  ...overrides,
});

/** A `browser-support` fixture, matching `support-rollup.test.ts`'s `supportEvent`. */
const supportEvent = (
  featureId: string,
  name: string,
  browser: string,
  version: string,
): ChangeEvent => ({
  id: `${featureId}:${browser}`,
  type: "browser-support",
  subject: { kind: "feature", id: featureId },
  title: `${browser} ${version} supports ${name}`,
  before: null,
  after: { browser, version },
  occurredAt: null,
  taxonomy: ["css"],
  dedupeKey: `k:${featureId}:${browser}`,
  correlationKey: `c:${featureId}:${browser}`,
  provenance: [
    {
      sourceId: "web-features",
      url: `https://webstatus.dev/features/${featureId}`,
      title: name,
      observedAt: "2026-07-15T00:00:00Z",
    },
  ],
  significance: 0.4,
  firstObservedAt: "2026-07-15T00:00:00Z",
  lastUpdatedAt: "2026-07-15T00:00:00Z",
});

describe("orderForDigest", () => {
  it("groups events by theme and ranks by significance within a group (§9)", () => {
    const ordered = orderForDigest([
      event("css-minor", { taxonomy: ["css"], significance: 0.4 }),
      event("node-release", {
        type: "runtime-release",
        subject: { kind: "runtime", name: "node", version: "25.0.0" },
        taxonomy: ["runtime", "node"],
        significance: 0.8,
      }),
      event("css-major", { taxonomy: ["css"], significance: 0.9 }),
    ]);
    expect(ordered.map((e) => e.id)).toEqual(["css-major", "css-minor", "node-release"]);
  });

  it("is deterministic for equal significance", () => {
    const events = [event("b", { significance: 0.5 }), event("a", { significance: 0.5 })];
    expect(orderForDigest(events).map((e) => e.id)).toEqual(["a", "b"]);
    expect(orderForDigest([...events].reverse()).map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("returns an empty list for no events", () => {
    expect(orderForDigest([])).toEqual([]);
  });
});

describe("themeUnits", () => {
  it("returns rest units first, then rollup units, matching the renderers' order", () => {
    const rest1 = event("css-a", { significance: 0.9 });
    const rest2 = event("css-b", { significance: 0.8 });
    const rollupEvents = [
      supportEvent("text-fit", "text-fit", "chrome", "150"),
      supportEvent("text-fit", "text-fit", "edge", "150"),
    ];

    const units = themeUnits([rest1, rollupEvents[0]!, rest2, rollupEvents[1]!]);

    expect(units.map((u) => u.kind)).toEqual(["event", "event", "rollup"]);
    expect(units.map((u) => u.key)).toEqual(["css-a", "css-b", "Chrome and Edge 150 now support"]);
  });

  it("collapses several browser-support events into a single rollup unit", () => {
    const units = themeUnits([
      supportEvent("text-fit", "text-fit", "chrome", "150"),
      supportEvent("text-fit", "text-fit", "chrome_android", "150"),
      supportEvent("text-fit", "text-fit", "edge", "150"),
    ]);

    expect(units).toHaveLength(1);
    expect(units[0]?.kind).toBe("rollup");
  });
});

describe("capThemeGroup", () => {
  it("leaves a group under the cap unchanged with no hidden units", () => {
    const items = Array.from({ length: THEME_ITEM_CAP - 1 }, (_, i) =>
      event(`css-${i}`, { significance: 1 - i * 0.01 }),
    );
    const { visible, hidden } = capThemeGroup({ theme: "css", items });

    expect(visible.map((u) => u.key)).toEqual(items.map((e) => e.id));
    expect(hidden).toEqual([]);
  });

  it("leaves a group exactly at the cap unchanged with no hidden units", () => {
    const items = Array.from({ length: THEME_ITEM_CAP }, (_, i) =>
      event(`css-${i}`, { significance: 1 - i * 0.01 }),
    );
    const { visible, hidden } = capThemeGroup({ theme: "css", items });

    expect(visible.map((u) => u.key)).toEqual(items.map((e) => e.id));
    expect(hidden).toEqual([]);
  });

  it("keeps exactly the cap's worth visible and reports the excess as hidden", () => {
    const items = Array.from({ length: THEME_ITEM_CAP + 3 }, (_, i) =>
      event(`css-${i}`, { significance: 1 - i * 0.01 }),
    );
    const { visible, hidden } = capThemeGroup({ theme: "css", items });

    expect(visible).toHaveLength(THEME_ITEM_CAP);
    expect(visible.map((u) => u.key)).toEqual(items.slice(0, THEME_ITEM_CAP).map((e) => e.id));
    expect(hidden).toHaveLength(3);
    expect(hidden.map((u) => u.key)).toEqual(items.slice(THEME_ITEM_CAP).map((e) => e.id));
  });

  it("never folds a rollup, however many plain events overflow", () => {
    const rest = Array.from({ length: THEME_ITEM_CAP + 3 }, (_, i) =>
      event(`css-${i}`, { significance: 1 - i * 0.01 }),
    );
    const rollupEvents = [
      supportEvent("text-fit", "text-fit", "chrome", "150"),
      supportEvent("text-fit", "text-fit", "edge", "150"),
    ];
    const { visible, hidden } = capThemeGroup({ theme: "css", items: [...rest, ...rollupEvents] });

    // Five capped events, then the rollup — which survives despite the overflow.
    expect(visible.map((u) => u.kind)).toEqual([
      ...Array.from({ length: THEME_ITEM_CAP }, () => "event"),
      "rollup",
    ]);
    expect(hidden).toHaveLength(3);
    expect(hidden.every((u) => u.kind === "event")).toBe(true);
  });

  it("does not let a rollup consume cap room that plain events could use", () => {
    const rest = Array.from({ length: THEME_ITEM_CAP }, (_, i) =>
      event(`css-${i}`, { significance: 1 - i * 0.01 }),
    );
    const rollupEvents = [
      supportEvent("text-fit", "text-fit", "chrome", "150"),
      supportEvent("text-fit", "text-fit", "edge", "150"),
    ];
    const { visible, hidden } = capThemeGroup({ theme: "css", items: [...rest, ...rollupEvents] });

    expect(visible).toHaveLength(THEME_ITEM_CAP + 1);
    expect(visible.at(-1)?.kind).toBe("rollup");
    expect(hidden).toEqual([]);
  });
});
