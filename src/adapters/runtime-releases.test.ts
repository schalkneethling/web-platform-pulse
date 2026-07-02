import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import type { RuntimeRelease } from "../core/runtime-releases/diff.ts";
import {
  createRuntimeReleasesAdapter,
  parseGithubRelease,
  parseNodeIndex,
} from "./runtime-releases.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../tests/fixtures/runtime-releases/${name}`, import.meta.url), "utf8");

const loadReleases = (name: string): RuntimeRelease[] =>
  JSON.parse(fixture(name)) as RuntimeRelease[];

const NOW = new Date("2026-06-10T12:00:00Z");

describe("parseNodeIndex", () => {
  it("takes the newest Current and the newest LTS patch", () => {
    expect(parseNodeIndex(JSON.parse(fixture("node-index.json")))).toEqual([
      {
        runtime: "node",
        line: "current",
        version: "26.4.0",
        releasedAt: "2026-06-24",
        url: "https://nodejs.org/en/blog/release/v26.4.0",
      },
      {
        runtime: "node",
        line: "lts",
        version: "24.12.0",
        releasedAt: "2026-06-10",
        url: "https://nodejs.org/en/blog/release/v24.12.0",
      },
    ]);
  });

  it("returns nothing for an empty index", () => {
    expect(parseNodeIndex([])).toEqual([]);
  });
});

describe("parseGithubRelease", () => {
  it("reads Deno's plain v-tag", () => {
    expect(parseGithubRelease(JSON.parse(fixture("deno-release.json")), "deno")).toEqual({
      runtime: "deno",
      line: "stable",
      version: "2.9.1",
      releasedAt: "2026-07-01",
      url: "https://github.com/denoland/deno/releases/tag/v2.9.1",
    });
  });

  it("strips Bun's bun-v tag prefix", () => {
    expect(parseGithubRelease(JSON.parse(fixture("bun-release.json")), "bun")).toMatchObject({
      runtime: "bun",
      version: "1.3.14",
      releasedAt: "2026-05-13",
    });
  });

  it("ignores prereleases", () => {
    expect(parseGithubRelease({ tag_name: "v3.0.0-rc.1", prerelease: true }, "deno")).toBeNull();
  });
});

describe("runtime-releases adapter", () => {
  it("seeds silently on first run and returns the version index as cursor (§5.3)", async () => {
    const adapter = createRuntimeReleasesAdapter({
      fetchReleases: () => Promise.resolve(loadReleases("old.json")),
      now: () => NOW,
    });
    const { events, cursor } = await adapter.run(null);
    expect(events).toEqual([]);
    expect(cursor).toEqual({
      "node:current": "26.2.0",
      "node:lts": "24.11.0",
      "deno:stable": "2.8.0",
      "bun:stable": "1.3.13",
    });
  });

  it("emits the delta between cursor and fetched releases on subsequent runs", async () => {
    const seeded = await createRuntimeReleasesAdapter({
      fetchReleases: () => Promise.resolve(loadReleases("old.json")),
      now: () => NOW,
    }).run(null);

    const { events, cursor } = await createRuntimeReleasesAdapter({
      fetchReleases: () => Promise.resolve(loadReleases("new.json")),
      now: () => NOW,
    }).run(seeded.cursor);

    expect(events.map((e) => e.dedupeKey).sort()).toEqual([
      "runtime-releases:release:bun:stable:1.3.14",
      "runtime-releases:release:node:current:26.3.0",
    ]);
    expect(cursor["deno:stable"]).toBe("2.8.0");
  });

  it("a feed yielding no release leaves that line's cursor untouched", async () => {
    const adapter = createRuntimeReleasesAdapter({
      fetchReleases: () => Promise.resolve(loadReleases("new.json").slice(0, 1)),
      now: () => NOW,
    });
    const { cursor } = await adapter.run({ "node:current": "26.2.0", "deno:stable": "2.8.0" });
    expect(cursor).toEqual({ "node:current": "26.3.0", "deno:stable": "2.8.0" });
  });
});
