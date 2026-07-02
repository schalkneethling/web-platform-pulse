import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import type { CandidateEvent } from "../../src/core/types.ts";
import { connect } from "../../src/store/db.ts";
import {
  assembleDigest,
  digestsAwaitingDelivery,
  ensureOperator,
  ensureSource,
  getDigest,
  getLatestDigest,
  ingestCandidates,
  loadSourceState,
  recordDelivery,
  saveSourceState,
} from "../../src/store/store.ts";

const sql = connect();

const candidate = (overrides: Partial<CandidateEvent>): CandidateEvent => ({
  type: "baseline-change",
  subject: { kind: "feature", id: "lh" },
  title: "lh unit is now Baseline widely available",
  before: { baseline: "low" },
  after: { baseline: "high" },
  occurredAt: "2026-05-21",
  taxonomy: ["css"],
  dedupeKey: "web-features:baseline:lh:low->high",
  correlationKey: "baseline:lh:high",
  provenance: [
    {
      sourceId: "web-features",
      url: "https://webstatus.dev/features/lh",
      title: "lh unit",
      observedAt: "2026-06-10T12:00:00.000Z",
    },
  ],
  ...overrides,
});

beforeEach(async () => {
  await sql`truncate change_event, event_source, digest, digest_item, source_state, subscription, subscriber restart identity cascade`;
  await ensureSource(sql, "web-features", "artifact-diff");
  await ensureSource(sql, "webstatus", "api-poll");
});

afterAll(async () => {
  await sql.end();
});

describe("ingestCandidates", () => {
  it("creates one change_event with provenance", async () => {
    const result = await ingestCandidates(sql, [candidate({})]);
    expect(result).toEqual({ created: 1, correlated: 0, unchanged: 0 });

    const events = await sql`select * from change_event`;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "baseline-change",
      title: "lh unit is now Baseline widely available",
      dedupe_key: "web-features:baseline:lh:low->high",
    });
    const provenance = await sql`select * from event_source`;
    expect(provenance).toHaveLength(1);
  });

  it("is idempotent: re-ingesting the same candidate writes nothing", async () => {
    await ingestCandidates(sql, [candidate({})]);
    const again = await ingestCandidates(sql, [candidate({})]);
    expect(again).toEqual({ created: 0, correlated: 0, unchanged: 1 });
    expect(await sql`select count(*)::int as n from change_event`).toMatchObject([{ n: 1 }]);
    expect(await sql`select count(*)::int as n from event_source`).toMatchObject([{ n: 1 }]);
  });

  it("correlates a second source's observation onto the same event (§7)", async () => {
    await ingestCandidates(sql, [candidate({})]);
    const fromWebstatus = candidate({
      dedupeKey: "webstatus:baseline:lh:high",
      provenance: [
        {
          sourceId: "webstatus",
          url: "https://webstatus.dev/features/lh?source=api",
          title: "lh unit",
          observedAt: "2026-06-10T13:00:00.000Z",
        },
      ],
    });
    const result = await ingestCandidates(sql, [fromWebstatus]);
    expect(result).toEqual({ created: 0, correlated: 1, unchanged: 0 });

    expect(await sql`select count(*)::int as n from change_event`).toMatchObject([{ n: 1 }]);
    expect(await sql`select count(*)::int as n from event_source`).toMatchObject([{ n: 2 }]);
  });
});

describe("source state", () => {
  it("round-trips and overwrites adapter state", async () => {
    expect(await loadSourceState(sql, "web-features")).toBeNull();
    await saveSourceState(sql, "web-features", { lh: { baseline: "high" } });
    await saveSourceState(sql, "web-features", { lh: { baseline: "low" } });
    expect(await loadSourceState(sql, "web-features")).toEqual({ lh: { baseline: "low" } });
  });
});

describe("digest assembly", () => {
  it("batches undelivered events into one ordered digest and is idempotent", async () => {
    const subscriberId = await ensureOperator(sql, "operator@example.com");
    await ingestCandidates(sql, [
      candidate({}),
      candidate({
        type: "browser-support",
        subject: { kind: "feature", id: "crisp-edges" },
        title: "Safari 7 supports crisp-edges",
        before: null,
        after: { browser: "safari", version: "7" },
        occurredAt: null,
        dedupeKey: "web-features:support:crisp-edges:safari:7",
        correlationKey: "support:crisp-edges:safari:7",
      }),
    ]);

    const digestId = await assembleDigest(sql, subscriberId);
    expect(digestId).not.toBeNull();

    const view = await getLatestDigest(sql, subscriberId);
    expect(view?.id).toBe(digestId);
    // higher-significance baseline change ranks first within the css theme
    expect(view?.items.map((i) => i.title)).toEqual([
      "lh unit is now Baseline widely available",
      "Safari 7 supports crisp-edges",
    ]);
    expect(view?.items[0]?.provenance[0]?.url).toBe("https://webstatus.dev/features/lh");

    // no new events -> no new digest
    expect(await assembleDigest(sql, subscriberId)).toBeNull();
    expect(await sql`select count(*)::int as n from digest`).toMatchObject([{ n: 1 }]);
  });

  it("filters by the subscription's taxonomies and significance floor", async () => {
    const subscriberId = await ensureOperator(sql, "operator@example.com");
    await sql`
      update subscription set taxonomies = ${["css"]}, significance_floor = 0.5
      where subscriber_id = ${subscriberId}
    `;
    await ingestCandidates(sql, [
      // css, significance 0.9: matches
      candidate({}),
      // css, significance 0.4: below the floor
      candidate({
        type: "browser-support",
        subject: { kind: "feature", id: "crisp-edges" },
        title: "Safari 7 supports crisp-edges",
        before: null,
        after: { browser: "safari", version: "7" },
        dedupeKey: "web-features:support:crisp-edges:safari:7",
        correlationKey: "support:crisp-edges:safari:7",
      }),
      // significance 0.9, but not a subscribed taxonomy
      candidate({
        subject: { kind: "feature", id: "urlpattern" },
        title: "URLPattern is now Baseline widely available",
        taxonomy: ["api"],
        dedupeKey: "web-features:baseline:urlpattern:low->high",
        correlationKey: "baseline:urlpattern:high",
      }),
    ]);

    const digestId = await assembleDigest(sql, subscriberId);
    const view = await getLatestDigest(sql, subscriberId);
    expect(view?.id).toBe(digestId);
    expect(view?.items.map((i) => i.title)).toEqual(["lh unit is now Baseline widely available"]);
  });

  it("a subscription without taxonomies matches every theme", async () => {
    const subscriberId = await ensureOperator(sql, "operator@example.com");
    await ingestCandidates(sql, [
      candidate({}),
      candidate({
        subject: { kind: "feature", id: "urlpattern" },
        title: "URLPattern is now Baseline widely available",
        taxonomy: ["api"],
        dedupeKey: "web-features:baseline:urlpattern:low->high",
        correlationKey: "baseline:urlpattern:high",
      }),
    ]);

    await assembleDigest(sql, subscriberId);
    const view = await getLatestDigest(sql, subscriberId);
    expect(view?.items).toHaveLength(2);
  });

  it("only includes events not already delivered", async () => {
    const subscriberId = await ensureOperator(sql, "operator@example.com");
    await ingestCandidates(sql, [candidate({})]);
    await assembleDigest(sql, subscriberId);

    await ingestCandidates(sql, [
      candidate({
        subject: { kind: "feature", id: "container-style-queries" },
        title: "Container style queries is now Baseline newly available",
        before: { baseline: false },
        after: { baseline: "low" },
        dedupeKey: "web-features:baseline:container-style-queries:false->low",
        correlationKey: "baseline:container-style-queries:low",
      }),
    ]);
    const secondId = await assembleDigest(sql, subscriberId);
    expect(secondId).not.toBeNull();

    const view = await getLatestDigest(sql, subscriberId);
    expect(view?.id).toBe(secondId);
    expect(view?.items).toHaveLength(1);
    expect(view?.items[0]?.title).toContain("Container style queries");
  });
});

describe("delivery records (§10)", () => {
  const assembleOne = async (): Promise<string> => {
    const subscriberId = await ensureOperator(sql, "operator@example.com");
    await ingestCandidates(sql, [candidate({})]);
    const digestId = await assembleDigest(sql, subscriberId);
    if (digestId === null) throw new Error("expected a digest");
    return digestId;
  };

  it("a digest awaits delivery until the channel has sent it", async () => {
    const digestId = await assembleOne();
    expect(await digestsAwaitingDelivery(sql, "email")).toEqual([
      { digestId, email: "operator@example.com" },
    ]);

    const view = await getDigest(sql, digestId);
    expect(view?.items[0]?.title).toBe("lh unit is now Baseline widely available");

    await recordDelivery(sql, digestId, "email", { status: "sent" });
    expect(await digestsAwaitingDelivery(sql, "email")).toEqual([]);
  });

  it("a failed attempt keeps the digest awaiting, with the error on record", async () => {
    const digestId = await assembleOne();
    await recordDelivery(sql, digestId, "email", { status: "failed", error: "ECONNREFUSED" });
    expect(await digestsAwaitingDelivery(sql, "email")).toEqual([
      { digestId, email: "operator@example.com" },
    ]);

    await recordDelivery(sql, digestId, "email", { status: "sent" });
    expect(await digestsAwaitingDelivery(sql, "email")).toEqual([]);

    const attempts = await sql<{ status: string; error: string | null }[]>`
      select status, error from delivery where digest_id = ${digestId} order by attempted_at
    `;
    expect(attempts).toMatchObject([
      { status: "failed", error: "ECONNREFUSED" },
      { status: "sent", error: null },
    ]);
  });

  it("each channel is tracked independently", async () => {
    const digestId = await assembleOne();
    await recordDelivery(sql, digestId, "email", { status: "sent" });
    expect(await digestsAwaitingDelivery(sql, "webhook")).toEqual([
      { digestId, email: "operator@example.com" },
    ]);
  });
});
