import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import type { ChromeFeature } from "../core/chrome-status/diff.ts";
import { createChromeStatusAdapter, parseChromeFeatures } from "./chrome-status.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../tests/fixtures/chrome-status/${name}`, import.meta.url), "utf8");

const loadFeatures = (name: string): ChromeFeature[] =>
  JSON.parse(fixture(name)) as ChromeFeature[];

describe("parseChromeFeatures", () => {
  it("maps API entries onto features, keeping only numeric milestones", () => {
    const features = parseChromeFeatures(JSON.parse(fixture("page.json")));
    expect(features).toEqual([
      {
        id: "5144822362931200",
        name: "CSS anchor positioning",
        status: "Enabled by default",
        milestone: "125",
        webFeature: "anchor-positioning",
        specUrl: "https://drafts.csswg.org/css-anchor-position-1/",
        category: "CSS",
      },
      {
        id: "5167864517623808",
        name: "Web haptics",
        status: "Proposed",
        milestone: null,
        webFeature: null,
        specUrl: null,
        category: "Miscellaneous",
      },
    ]);
  });

  it("skips deleted entries and entries without a Chrome status", () => {
    const ids = parseChromeFeatures(JSON.parse(fixture("page.json"))).map((f) => f.id);
    expect(ids).not.toContain("5111111111111111");
    expect(ids).not.toContain("5222222222222222");
  });
});

describe("chrome-status adapter", () => {
  it("seeds silently on first run and returns the status index as cursor (§5.3)", async () => {
    const adapter = createChromeStatusAdapter({
      fetchFeatures: () => Promise.resolve(loadFeatures("old.json")),
    });
    const { events, cursor } = await adapter.run(null);
    expect(events).toEqual([]);
    expect(cursor).toEqual({
      "5144822362931200": "Origin trial",
      "5633461050195968": "Enabled by default",
      "5167864517623808": "Proposed",
    });
  });

  it("emits the delta between cursor and fetched features on subsequent runs", async () => {
    const seeded = await createChromeStatusAdapter({
      fetchFeatures: () => Promise.resolve(loadFeatures("old.json")),
    }).run(null);

    const { events, cursor } = await createChromeStatusAdapter({
      fetchFeatures: () => Promise.resolve(loadFeatures("new.json")),
    }).run(seeded.cursor);

    expect(events.map((e) => e.title).sort()).toEqual([
      "CSS anchor positioning shipped in Chrome 125",
      "Mutation events deprecated in Chrome 127",
      "Speculation rules: target_hint field entered origin trial in Chrome 126",
    ]);
    expect(cursor["5144822362931200"]).toBe("Enabled by default");
  });

  it("a dump omitting a feature leaves its cursor entry untouched", async () => {
    const adapter = createChromeStatusAdapter({
      fetchFeatures: () => Promise.resolve(loadFeatures("new.json").slice(0, 1)),
    });
    const { cursor } = await adapter.run({
      "5144822362931200": "Origin trial",
      "5633461050195968": "Enabled by default",
    });
    expect(cursor).toEqual({
      "5144822362931200": "Enabled by default",
      "5633461050195968": "Enabled by default",
    });
  });
});
