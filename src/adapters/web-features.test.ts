import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import type { WebFeaturesData } from "../core/web-features/diff.ts";
import { createWebFeaturesAdapter } from "./web-features.ts";

const load = (name: string): WebFeaturesData =>
  JSON.parse(
    readFileSync(new URL(`../../tests/fixtures/web-features/${name}`, import.meta.url), "utf8"),
  ) as WebFeaturesData;

const NOW = new Date("2026-06-10T12:00:00Z");

describe("web-features adapter", () => {
  it("seeds silently on first run and returns the derived index as cursor (§5.3)", async () => {
    const adapter = createWebFeaturesAdapter({
      fetchData: () => Promise.resolve(load("old.json")),
      now: () => NOW,
    });
    const { events, cursor } = await adapter.run(null);
    expect(events).toEqual([]);
    expect(Object.keys(cursor)).toContain("lh");
  });

  it("emits the delta between cursor and fetched data on subsequent runs", async () => {
    const adapter = createWebFeaturesAdapter({
      fetchData: () => Promise.resolve(load("old.json")),
      now: () => NOW,
    });
    const first = await adapter.run(null);

    const second = createWebFeaturesAdapter({
      fetchData: () => Promise.resolve(load("new.json")),
      now: () => NOW,
    });
    const { events, cursor } = await second.run(first.cursor);
    expect(events.map((e) => e.dedupeKey).sort()).toEqual([
      "web-features:baseline:container-style-queries:false->low",
      "web-features:baseline:contrast-color:false->low",
      "web-features:baseline:lh:low->high",
      "web-features:support:crisp-edges:safari:7",
    ]);
    expect(cursor["contrast-color"]).toBeDefined();
  });

  it("is idempotent: the same upstream state emits the same events and cursor", async () => {
    const adapter = createWebFeaturesAdapter({
      fetchData: () => Promise.resolve(load("new.json")),
      now: () => NOW,
    });
    const seeded = await adapter.run(null);
    const runA = await adapter.run(seeded.cursor);
    const runB = await adapter.run(seeded.cursor);
    expect(runA).toEqual(runB);
    expect(runA.events).toEqual([]);
  });
});
