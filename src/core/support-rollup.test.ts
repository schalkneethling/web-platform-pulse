import { describe, expect, it } from "vite-plus/test";
import { listJoin, splitBrowserSupport } from "./support-rollup.ts";
import type { ChangeEvent } from "./types.ts";

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

describe("listJoin", () => {
  it("joins with commas and a final and", () => {
    expect(listJoin([])).toBe("");
    expect(listJoin(["a"])).toBe("a");
    expect(listJoin(["a", "b"])).toBe("a and b");
    expect(listJoin(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("splitBrowserSupport", () => {
  it("rolls features with identical browser support into one sentence lead", () => {
    const { rest, rollups } = splitBrowserSupport([
      supportEvent("text-fit", "text-fit", "chrome", "150"),
      supportEvent("text-fit", "text-fit", "chrome_android", "150"),
      supportEvent("text-fit", "text-fit", "edge", "150"),
      supportEvent("light-dark-image", "light-dark() image values", "chrome", "150"),
      supportEvent("light-dark-image", "light-dark() image values", "chrome_android", "150"),
      supportEvent("light-dark-image", "light-dark() image values", "edge", "150"),
    ]);

    expect(rest).toEqual([]);
    expect(rollups).toHaveLength(1);
    expect(rollups[0]?.lead).toBe("Chrome, Chrome on Android and Edge 150 now support");
    expect(rollups[0]?.features.map((f) => f.name)).toEqual([
      "light-dark() image values",
      "text-fit",
    ]);
    expect(rollups[0]?.features[1]?.url).toBe("https://webstatus.dev/features/text-fit");
  });

  it("keeps features with different support signatures in separate rollups", () => {
    const { rollups } = splitBrowserSupport([
      supportEvent("supports-at-rule", "at-rule()", "chrome", "148"),
      supportEvent("supports-at-rule", "at-rule()", "edge", "148"),
      supportEvent("text-fit", "text-fit", "chrome", "150"),
    ]);

    expect(rollups.map((r) => r.lead)).toEqual([
      "Chrome and Edge 148 now support",
      "Chrome 150 now supports",
    ]);
  });

  it("spells out per-browser versions when they differ within one feature", () => {
    const { rollups } = splitBrowserSupport([
      supportEvent("text-fit", "text-fit", "firefox", "145"),
      supportEvent("text-fit", "text-fit", "chrome", "150"),
    ]);

    expect(rollups).toHaveLength(1);
    expect(rollups[0]?.lead).toBe("Chrome 150 and Firefox 145 now support");
  });

  it("orders browsers Chromium-first regardless of event order", () => {
    const { rollups } = splitBrowserSupport([
      supportEvent("text-fit", "text-fit", "safari", "26"),
      supportEvent("text-fit", "text-fit", "chrome", "150"),
    ]);

    expect(rollups[0]?.lead).toBe("Chrome 150 and Safari 26 now support");
  });

  it("passes non-support events through untouched, in order", () => {
    const baseline: ChangeEvent = {
      ...supportEvent("lh", "lh unit", "chrome", "150"),
      type: "baseline-change",
      after: { baseline: "low" },
    };
    const { rest, rollups } = splitBrowserSupport([
      baseline,
      supportEvent("text-fit", "text-fit", "chrome", "150"),
    ]);

    expect(rest).toEqual([baseline]);
    expect(rollups).toHaveLength(1);
  });
});
