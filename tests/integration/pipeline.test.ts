import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createBrowserReleasesAdapter } from "../../src/adapters/browser-releases.ts";
import { createChromeStatusAdapter } from "../../src/adapters/chrome-status.ts";
import { createRuntimeReleasesAdapter } from "../../src/adapters/runtime-releases.ts";
import { createStandardsPositionsAdapter } from "../../src/adapters/standards-positions.ts";
import { createWebFeaturesAdapter } from "../../src/adapters/web-features.ts";
import { runPipeline } from "../../src/cli/pipeline.ts";
import type { SourceAdapter } from "../../src/core/adapter.ts";
import type { BrowserRelease } from "../../src/core/browser-releases/diff.ts";
import type { ChromeFeature } from "../../src/core/chrome-status/diff.ts";
import type { RuntimeRelease } from "../../src/core/runtime-releases/diff.ts";
import type { VendorPosition } from "../../src/core/standards-positions/diff.ts";
import type { WebFeaturesData } from "../../src/core/web-features/diff.ts";
import { connect } from "../../src/store/db.ts";
import { getLatestDigest } from "../../src/store/store.ts";

const sql = connect();

const loadFixture = <T>(dir: string, name: string): T =>
  JSON.parse(readFileSync(new URL(`../fixtures/${dir}/${name}`, import.meta.url), "utf8")) as T;

const NOW = new Date("2026-06-10T12:00:00Z");

const webFeaturesAdapter = (fixture: string) =>
  createWebFeaturesAdapter({
    fetchData: () => Promise.resolve(loadFixture<WebFeaturesData>("web-features", fixture)),
    now: () => NOW,
  });

const browserReleasesAdapter = (fixture: string) =>
  createBrowserReleasesAdapter({
    fetchReleases: () =>
      Promise.resolve(loadFixture<BrowserRelease[]>("browser-releases", fixture)),
    now: () => NOW,
  });

const runtimeReleasesAdapter = (fixture: string) =>
  createRuntimeReleasesAdapter({
    fetchReleases: () =>
      Promise.resolve(loadFixture<RuntimeRelease[]>("runtime-releases", fixture)),
    now: () => NOW,
  });

const chromeStatusAdapter = (fixture: string) =>
  createChromeStatusAdapter({
    fetchFeatures: () => Promise.resolve(loadFixture<ChromeFeature[]>("chrome-status", fixture)),
    now: () => NOW,
  });

const standardsPositionsAdapter = (fixture: string) =>
  createStandardsPositionsAdapter({
    fetchPositions: () =>
      Promise.resolve(loadFixture<VendorPosition[]>("standards-positions", fixture)),
    now: () => NOW,
  });

// Events are ingested at the database's real clock; a now a full window
// ahead lets the daily window close so assembly can cut it.
const LATER = () => new Date(Date.now() + 25 * 60 * 60 * 1000);

const run = (adapters: SourceAdapter[]) =>
  runPipeline(sql, { adapters, subscriberEmail: "operator@example.com", now: LATER });

beforeEach(async () => {
  await sql`truncate change_event, event_source, digest, digest_item, source_state, subscription, subscriber restart identity cascade`;
});

afterAll(async () => {
  await sql.end();
});

describe("runPipeline", () => {
  it("cold-starts silently, then turns the next observation into a digest", async () => {
    const first = await run([webFeaturesAdapter("old.json")]);
    expect(first.candidates).toBe(0);
    expect(first.digestIds).toEqual([]);

    const second = await run([webFeaturesAdapter("new.json")]);
    expect(second.ingest.created).toBe(4);
    expect(second.digestIds).toHaveLength(1);

    const subscriber = await sql<{ id: string }[]>`select id from subscriber`;
    const digest = await getLatestDigest(sql, subscriber[0]!.id);
    expect(digest?.items).toHaveLength(4);
    const lh = digest?.items.find((i) => i.subject.kind === "feature" && i.subject.id === "lh");
    expect(lh?.title).toMatch(/widely available/i);
    expect(lh?.provenance[0]?.url).toBe("https://webstatus.dev/features/lh");
  });

  it("a repeated run with the same upstream state changes nothing", async () => {
    await run([webFeaturesAdapter("old.json")]);
    await run([webFeaturesAdapter("new.json")]);
    const repeat = await run([webFeaturesAdapter("new.json")]);
    expect(repeat.candidates).toBe(0);
    expect(repeat.ingest).toEqual({ created: 0, correlated: 0, unchanged: 0 });
    expect(repeat.digestIds).toEqual([]);
    expect(await sql`select count(*)::int as n from digest`).toMatchObject([{ n: 1 }]);
  });

  it("all sources contribute to one digest: platform work, then browsers, then runtimes", async () => {
    const adapters = (fixture: string) => [
      webFeaturesAdapter(fixture),
      browserReleasesAdapter(fixture),
      runtimeReleasesAdapter(fixture),
      standardsPositionsAdapter(fixture),
      chromeStatusAdapter(fixture),
    ];
    await run(adapters("old.json"));
    const second = await run(adapters("new.json"));
    expect(second.ingest.created).toBe(15);
    expect(second.sourceFailures).toEqual([]);

    const subscriber = await sql<{ id: string }[]>`select id from subscriber`;
    const digest = await getLatestDigest(sql, subscriber[0]!.id);
    expect(digest?.items).toHaveLength(15);

    const types = new Set(digest?.items.map((i) => i.type));
    expect(types).toContain("baseline-change");
    expect(types).toContain("browser-release");
    expect(types).toContain("runtime-release");
    expect(types).toContain("vendor-position");
    expect(types).toContain("feature-status");

    const themes = digest!.items.map((i) => i.taxonomy[0]);
    expect(themes.indexOf("browser")).toBeGreaterThan(themes.lastIndexOf("css"));
    expect(themes.indexOf("runtime")).toBeGreaterThan(themes.lastIndexOf("browser"));
  });

  it("a failing source is skipped without blocking the others", async () => {
    await run([webFeaturesAdapter("old.json")]);

    const broken: SourceAdapter = {
      sourceId: "broken-feed",
      kind: "artifact-diff",
      run: () => Promise.reject(new Error("upstream down")),
    };
    const summary = await run([webFeaturesAdapter("new.json"), broken]);
    expect(summary.sourceFailures).toEqual(["broken-feed"]);
    expect(summary.ingest.created).toBe(4);
    expect(summary.digestIds).toHaveLength(1);

    const state = await sql<{ source_id: string }[]>`select source_id from source_state`;
    expect(state.map((row) => row.source_id)).toEqual(["web-features"]);
  });
});
