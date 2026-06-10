import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { runPipeline } from "../../src/cli/pipeline.ts";
import type { WebFeaturesData } from "../../src/core/web-features/diff.ts";
import { connect } from "../../src/store/db.ts";
import { getLatestDigest } from "../../src/store/store.ts";

const sql = connect();

const load = (name: string): WebFeaturesData =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/web-features/${name}`, import.meta.url), "utf8"),
  ) as WebFeaturesData;

const NOW = new Date("2026-06-10T12:00:00Z");

const run = (fixture: string) =>
  runPipeline(sql, {
    fetchData: () => Promise.resolve(load(fixture)),
    now: () => NOW,
    subscriberEmail: "operator@example.com",
  });

beforeEach(async () => {
  await sql`truncate change_event, event_source, digest, digest_item, source_state, subscription, subscriber restart identity cascade`;
});

afterAll(async () => {
  await sql.end();
});

describe("runPipeline", () => {
  it("cold-starts silently, then turns the next observation into a digest", async () => {
    const first = await run("old.json");
    expect(first.candidates).toBe(0);
    expect(first.digestId).toBeNull();

    const second = await run("new.json");
    expect(second.ingest.created).toBe(4);
    expect(second.digestId).not.toBeNull();

    const subscriber = await sql<{ id: string }[]>`select id from subscriber`;
    const digest = await getLatestDigest(sql, subscriber[0]!.id);
    expect(digest?.items).toHaveLength(4);
    const lh = digest?.items.find((i) => i.subject.kind === "feature" && i.subject.id === "lh");
    expect(lh?.title).toMatch(/widely available/i);
    expect(lh?.provenance[0]?.url).toBe("https://webstatus.dev/features/lh");
  });

  it("a repeated run with the same upstream state changes nothing", async () => {
    await run("old.json");
    await run("new.json");
    const repeat = await run("new.json");
    expect(repeat.candidates).toBe(0);
    expect(repeat.ingest).toEqual({ created: 0, correlated: 0, unchanged: 0 });
    expect(repeat.digestId).toBeNull();
    expect(await sql`select count(*)::int as n from digest`).toMatchObject([{ n: 1 }]);
  });
});
