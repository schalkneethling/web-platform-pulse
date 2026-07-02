import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createBrowserReleasesAdapter } from "../../src/adapters/browser-releases.ts";
import { createWebFeaturesAdapter } from "../../src/adapters/web-features.ts";
import { runPipeline } from "../../src/cli/pipeline.ts";
import type { SourceAdapter } from "../../src/core/adapter.ts";
import type { BrowserRelease } from "../../src/core/browser-releases/diff.ts";
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

  it("both sources contribute to one digest, browsers grouped after platform work", async () => {
    await run([webFeaturesAdapter("old.json"), browserReleasesAdapter("old.json")]);
    const second = await run([webFeaturesAdapter("new.json"), browserReleasesAdapter("new.json")]);
    expect(second.ingest.created).toBe(7);
    expect(second.sourceFailures).toEqual([]);

    const subscriber = await sql<{ id: string }[]>`select id from subscriber`;
    const digest = await getLatestDigest(sql, subscriber[0]!.id);
    expect(digest?.items).toHaveLength(7);

    const types = new Set(digest?.items.map((i) => i.type));
    expect(types).toContain("baseline-change");
    expect(types).toContain("browser-release");

    const themes = digest!.items.map((i) => i.taxonomy[0]);
    expect(themes.indexOf("browser")).toBeGreaterThan(themes.lastIndexOf("css"));
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
