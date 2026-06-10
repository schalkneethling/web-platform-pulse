import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { deriveIndex, diffWebFeatures } from "./diff.ts";
import type { WebFeaturesData } from "./diff.ts";

const load = (name: string): WebFeaturesData =>
  JSON.parse(
    readFileSync(new URL(`../../../tests/fixtures/web-features/${name}`, import.meta.url), "utf8"),
  ) as WebFeaturesData;

const oldData = load("old.json");
const newData = load("new.json");

const NOW = new Date("2026-06-10T12:00:00Z");
const OBSERVED_AT = "2026-06-10T12:00:00.000Z";

const diff = (prev: ReturnType<typeof deriveIndex> | null, next: ReturnType<typeof deriveIndex>) =>
  diffWebFeatures(prev, next, { now: NOW, observedAt: OBSERVED_AT });

describe("deriveIndex", () => {
  it("indexes baseline status, dates, support, and name per feature", () => {
    const index = deriveIndex(newData);
    expect(index["lh"]).toEqual({
      name: "lh unit",
      baseline: "high",
      lowDate: "2023-11-21",
      highDate: "2026-05-21",
      support: {
        chrome: "109",
        chrome_android: "109",
        edge: "109",
        firefox: "120",
        firefox_android: "120",
        safari: "16.4",
        safari_ios: "16.4",
      },
      taxonomy: ["css"],
    });
  });

  it("excludes moved and split entries", () => {
    const index = deriveIndex(newData);
    expect(index["masonry-layout"]).toBeUndefined();
  });
});

describe("diffWebFeatures", () => {
  const events = diff(deriveIndex(oldData), deriveIndex(newData));

  it("emits a widely-available baseline change for low -> high", () => {
    const event = events.find((e) => e.dedupeKey === "web-features:baseline:lh:low->high");
    expect(event).toBeDefined();
    expect(event).toMatchObject({
      type: "baseline-change",
      subject: { kind: "feature", id: "lh" },
      before: { baseline: "low" },
      after: { baseline: "high" },
      occurredAt: "2026-05-21",
      correlationKey: "baseline:lh:high",
      taxonomy: ["css"],
    });
    expect(event?.title).toContain("lh");
    expect(event?.title).toMatch(/widely available/i);
    expect(event?.provenance).toEqual([
      {
        sourceId: "web-features",
        url: "https://webstatus.dev/features/lh",
        title: "lh unit",
        observedAt: OBSERVED_AT,
      },
    ]);
  });

  it("emits a newly-available baseline change for false -> low", () => {
    const event = events.find(
      (e) => e.dedupeKey === "web-features:baseline:container-style-queries:false->low",
    );
    expect(event).toMatchObject({
      before: { baseline: false },
      after: { baseline: "low" },
      occurredAt: "2026-05-19",
      correlationKey: "baseline:container-style-queries:low",
    });
    expect(event?.title).toMatch(/newly available/i);
  });

  it("treats a feature absent from the previous index as a new baseline entry", () => {
    const event = events.find(
      (e) => e.subject.kind === "feature" && e.subject.id === "contrast-color",
    );
    expect(event).toMatchObject({
      type: "baseline-change",
      before: { baseline: false },
      after: { baseline: "low" },
    });
  });

  it("emits a browser-support event when a browser appears in the support map", () => {
    const event = events.find((e) => e.dedupeKey === "web-features:support:crisp-edges:safari:7");
    expect(event).toMatchObject({
      type: "browser-support",
      subject: { kind: "feature", id: "crisp-edges" },
      before: null,
      after: { browser: "safari", version: "7" },
      correlationKey: "support:crisp-edges:safari:7",
    });
    expect(event?.title).toMatch(/Safari/);
  });

  it("emits nothing for unchanged features", () => {
    expect(events.some((e) => e.subject.kind === "feature" && e.subject.id === "has")).toBe(false);
  });

  it("is deterministic: the same inputs produce the same events", () => {
    expect(diff(deriveIndex(oldData), deriveIndex(newData))).toEqual(events);
  });

  it("emits nothing when nothing changed", () => {
    expect(diff(deriveIndex(newData), deriveIndex(newData))).toEqual([]);
  });

  describe("cold start (no previous index)", () => {
    it("emits only transitions dated within the seven days before now", () => {
      // baseline_high_date for storage-access in the live data is 2026-06-05,
      // within 7 days of NOW; lh (2026-05-21) is outside the window.
      const index = deriveIndex(newData);
      const recent = {
        ...index,
        "storage-access": {
          name: "Storage Access API",
          baseline: "high" as const,
          lowDate: "2024-04-01",
          highDate: "2026-06-05",
          support: { chrome: "119" },
          taxonomy: ["api"],
        },
      };
      const coldEvents = diff(null, recent);
      expect(coldEvents.map((e) => e.subject)).toEqual([{ kind: "feature", id: "storage-access" }]);
      expect(coldEvents[0]).toMatchObject({
        before: { baseline: "low" },
        after: { baseline: "high" },
      });
    });

    it("parses ranged dates of the form ≤YYYY-MM-DD", () => {
      const index = {
        ranged: {
          name: "Ranged",
          baseline: "high" as const,
          lowDate: "≤2020-01-01",
          highDate: "≤2026-06-08",
          support: {},
          taxonomy: ["css"],
        },
      };
      const coldEvents = diff(null, index);
      expect(coldEvents).toHaveLength(1);
      expect(coldEvents[0]?.occurredAt).toBe("2026-06-08");
    });
  });
});
