import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import type { VendorPosition } from "../core/standards-positions/diff.ts";
import {
  createStandardsPositionsAdapter,
  parseMozillaPositions,
  parseWebKitPositions,
} from "./standards-positions.ts";

const fixture = (name: string): string =>
  readFileSync(
    new URL(`../../tests/fixtures/standards-positions/${name}`, import.meta.url),
    "utf8",
  );

const loadPositions = (name: string): VendorPosition[] =>
  JSON.parse(fixture(name)) as VendorPosition[];

describe("parseMozillaPositions", () => {
  it("maps merged-data entries onto vendor positions", () => {
    const positions = parseMozillaPositions(JSON.parse(fixture("mozilla.json")));
    expect(positions.find((p) => p.key === "20")).toEqual({
      vendor: "mozilla",
      key: "20",
      position: "positive",
      title: "Trusted Types",
      specUrl: "https://w3c.github.io/trusted-types/dist/spec/",
      issueUrl: "https://github.com/mozilla/standards-positions/issues/20",
      topics: ["API"],
    });
  });

  it("keeps pending requests but skips untitled ones", () => {
    const positions = parseMozillaPositions(JSON.parse(fixture("mozilla.json")));
    expect(positions.find((p) => p.key === "1104")).toMatchObject({ position: null });
    expect(positions.find((p) => p.key === "1200")).toBeUndefined();
  });
});

describe("parseWebKitPositions", () => {
  it("takes the issue number from the id URL and skips untitled entries", () => {
    const positions = parseWebKitPositions(JSON.parse(fixture("webkit.json")));
    expect(positions.map((p) => p.key)).toEqual(["1", "77"]);
    expect(positions[0]).toEqual({
      vendor: "webkit",
      key: "1",
      position: "support",
      title: "Gamepad API Trigger-Rumble Extension",
      specUrl: "https://w3c.github.io/gamepad/extensions.html",
      issueUrl: "https://github.com/WebKit/standards-positions/issues/1",
      topics: ["web apis", "device apis"],
    });
  });
});

describe("standards-positions adapter", () => {
  it("seeds silently on first run and returns the position index as cursor (§5.3)", async () => {
    const adapter = createStandardsPositionsAdapter({
      fetchPositions: () => Promise.resolve(loadPositions("old.json")),
    });
    const { events, cursor } = await adapter.run(null);
    expect(events).toEqual([]);
    expect(cursor).toEqual({
      "mozilla:20": "neutral",
      "mozilla:1104": "none",
      "webkit:1": "support",
      "webkit:77": "none",
    });
  });

  it("emits the delta between cursor and fetched positions on subsequent runs", async () => {
    const seeded = await createStandardsPositionsAdapter({
      fetchPositions: () => Promise.resolve(loadPositions("old.json")),
    }).run(null);

    const { events, cursor } = await createStandardsPositionsAdapter({
      fetchPositions: () => Promise.resolve(loadPositions("new.json")),
    }).run(seeded.cursor);

    expect(events.map((e) => e.dedupeKey).sort()).toEqual([
      "standards-positions:position:mozilla:1200:negative",
      "standards-positions:position:mozilla:20:positive",
      "standards-positions:position:webkit:77:support",
    ]);
    expect(cursor["mozilla:20"]).toBe("positive");
  });

  it("an artifact omitting a proposal leaves its cursor entry untouched", async () => {
    const adapter = createStandardsPositionsAdapter({
      fetchPositions: () => Promise.resolve(loadPositions("new.json").slice(0, 1)),
    });
    const { cursor } = await adapter.run({ "mozilla:20": "neutral", "webkit:1": "support" });
    expect(cursor).toEqual({ "mozilla:20": "positive", "webkit:1": "support" });
  });
});
