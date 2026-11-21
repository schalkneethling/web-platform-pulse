import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import type { CandidateEvent } from "../../src/core/types.ts";
import { connect } from "../../src/store/db.ts";
import { getDraftIssue, ISSUE_PREFILL_LIMIT, openIssue } from "../../src/store/issue.ts";
import { CADENCE_PERIOD_MS, ensureSource, ingestCandidates } from "../../src/store/store.ts";

const sql = connect();

const NOW = new Date("2026-06-14T06:00:00.000Z");
const WEEK = CADENCE_PERIOD_MS["weekly"]!;
const DAY = CADENCE_PERIOD_MS["daily"]!;
const daysAgo = (days: number, from: Date = NOW): Date => new Date(from.getTime() - days * DAY);

const candidate = (key: string, overrides: Partial<CandidateEvent> = {}): CandidateEvent => ({
  type: "baseline-change",
  subject: { kind: "feature", id: key },
  title: `${key} reached Baseline`,
  before: null,
  after: { baseline: "high" },
  occurredAt: null,
  taxonomy: ["css"],
  dedupeKey: `test:${key}`,
  correlationKey: `test:${key}`,
  provenance: [
    {
      sourceId: "web-features",
      url: `https://example.com/${key}`,
      title: key,
      observedAt: NOW.toISOString(),
    },
  ],
  ...overrides,
});

/** Ingest one event and back-date it, since ingest stamps first_observed_at with now(). */
const seedEvent = async (
  key: string,
  observedAt: Date,
  overrides: Partial<CandidateEvent> = {},
): Promise<string> => {
  await ingestCandidates(sql, [candidate(key, overrides)]);
  const rows = await sql<{ id: string }[]>`
    update change_event set first_observed_at = ${observedAt}
    where dedupe_key = ${`test:${key}`} returning id
  `;
  return rows[0]!.id;
};

/** Publish by hand: the publish command arrives in a later sub-slice. */
const publishDirectly = async (issueId: string): Promise<void> => {
  await sql`update issue set status = 'published', published_at = now() where id = ${issueId}`;
};

beforeEach(async () => {
  await sql`truncate issue, issue_item, issue_delivery, change_event, event_source, digest, digest_item, source_state, subscription, subscriber restart identity cascade`;
  await ensureSource(sql, "web-features", "artifact-diff");
});

afterAll(async () => {
  await sql.end();
});

describe("openIssue", () => {
  it("creates issue 1 as a draft with the weekly window ending now", async () => {
    await seedEvent("a", daysAgo(1));
    const opened = await openIssue(sql, NOW);
    expect(opened.created).toBe(true);

    const draft = await getDraftIssue(sql);
    expect(draft).toMatchObject({
      number: 1,
      title: "",
      intro: "",
      status: "draft",
      windowStart: new Date(NOW.getTime() - WEEK).toISOString(),
      windowEnd: NOW.toISOString(),
    });
    expect(opened.issueId).toBe(draft?.id);
  });

  it("pre-fills items in digest order with the first as lead and positions from 1", async () => {
    await seedEvent("css-low", daysAgo(1), { taxonomy: ["css"], title: "CSS low" });
    await seedEvent("css-high", daysAgo(2), { taxonomy: ["css"], title: "CSS high" });
    await seedEvent("voice", daysAgo(3), {
      type: "editorial",
      taxonomy: ["voices"],
      title: "A voice",
    });
    await seedEvent("spec", daysAgo(3), {
      type: "spec-change",
      taxonomy: ["html"],
      title: "A spec",
    });
    // Significance is scored by ingest, so force an order inside the css theme.
    await sql`update change_event set significance = 0.2 where dedupe_key = 'test:css-low'`;
    await sql`update change_event set significance = 0.9 where dedupe_key = 'test:css-high'`;

    await openIssue(sql, NOW);
    const draft = await getDraftIssue(sql);

    expect(draft?.items.map((i) => [i.position, i.section, i.event.title, i.included])).toEqual([
      [1, "lead", "CSS high", true],
      [2, "shipped", "CSS low", true],
      [3, "watch", "A spec", true],
      [4, "voices", "A voice", true],
    ]);
    expect(draft?.items.every((i) => i.note === null)).toBe(true);
    // The read joins provenance so a renderer can link to the source.
    expect(draft?.items[0]?.event.provenance[0]?.url).toBe("https://example.com/css-high");
  });

  it("pre-fills at most ISSUE_PREFILL_LIMIT items", async () => {
    for (let i = 0; i < ISSUE_PREFILL_LIMIT + 3; i += 1) {
      await seedEvent(`e${i}`, daysAgo(1));
    }
    await openIssue(sql, NOW);
    expect((await getDraftIssue(sql))?.items).toHaveLength(ISSUE_PREFILL_LIMIT);
  });

  it("ignores events outside the window, treating the end as exclusive", async () => {
    await seedEvent("before", new Date(NOW.getTime() - WEEK - 1));
    await seedEvent("at-start", new Date(NOW.getTime() - WEEK));
    await seedEvent("at-end", NOW);
    await seedEvent("after", new Date(NOW.getTime() + 1));
    await openIssue(sql, NOW);
    expect((await getDraftIssue(sql))?.items.map((i) => i.event.title)).toEqual([
      "at-start reached Baseline",
    ]);
  });

  it("is a no-op while a draft exists", async () => {
    await seedEvent("a", daysAgo(1));
    const first = await openIssue(sql, NOW);
    const second = await openIssue(sql, new Date(NOW.getTime() + DAY));
    expect(second).toEqual({ created: false, issueId: first.issueId });

    expect(await sql`select count(*)::int as n from issue`).toMatchObject([{ n: 1 }]);
    expect(await sql`select count(*)::int as n from issue_item`).toMatchObject([{ n: 1 }]);
    const draft = await getDraftIssue(sql);
    expect(draft?.windowEnd).toBe(NOW.toISOString());
  });

  it("still creates a draft for a week with no events", async () => {
    const opened = await openIssue(sql, NOW);
    expect(opened.created).toBe(true);
    expect(await getDraftIssue(sql)).toMatchObject({ number: 1, items: [] });
  });

  it("starts the next window where the previous issue ended, so a skipped week loses nothing", async () => {
    const first = await openIssue(sql, NOW);
    await publishDirectly(first.issueId);

    // Two weeks later, with an event from the gap week that no issue covered.
    const later = new Date(NOW.getTime() + 2 * WEEK);
    await seedEvent("gap", new Date(NOW.getTime() + WEEK / 2));
    const second = await openIssue(sql, later);
    expect(second.created).toBe(true);

    const draft = await getDraftIssue(sql);
    expect(draft).toMatchObject({
      number: 2,
      windowStart: NOW.toISOString(),
      windowEnd: later.toISOString(),
    });
    expect(draft?.items.map((i) => i.event.title)).toEqual(["gap reached Baseline"]);
  });

  it("does not modify change_event or event_source", async () => {
    await seedEvent("a", daysAgo(1));
    await seedEvent("b", daysAgo(2));
    const snapshot = async () => ({
      events: await sql`select * from change_event order by dedupe_key`,
      sources: await sql`select * from event_source order by url`,
    });
    const before = await snapshot();
    await openIssue(sql, NOW);
    expect(await snapshot()).toEqual(before);
  });
});

describe("issue constraints", () => {
  it("rejects a second draft inserted directly", async () => {
    await openIssue(sql, NOW);
    await expect(
      sql`insert into issue (number, window_start, window_end)
          values (2, ${daysAgo(14)}, ${daysAgo(7)})`,
    ).rejects.toThrow(/issue_one_draft_idx/);
  });

  it("allows many published issues next to one draft", async () => {
    const first = await openIssue(sql, NOW);
    await publishDirectly(first.issueId);
    const second = await openIssue(sql, new Date(NOW.getTime() + WEEK));
    await publishDirectly(second.issueId);
    await openIssue(sql, new Date(NOW.getTime() + 2 * WEEK));
    expect(await sql`select status from issue order by number`).toMatchObject([
      { status: "published" },
      { status: "published" },
      { status: "draft" },
    ]);
  });

  it("keeps published_at null exactly while the issue is a draft", async () => {
    const { issueId } = await openIssue(sql, NOW);
    await expect(sql`update issue set published_at = now() where id = ${issueId}`).rejects.toThrow(
      /check/,
    );
    await expect(sql`update issue set status = 'published' where id = ${issueId}`).rejects.toThrow(
      /check/,
    );
  });

  it("rejects an inverted window, an unknown section and over-long text", async () => {
    const { issueId } = await openIssue(sql, NOW);
    await expect(
      sql`insert into issue (number, status, published_at, window_start, window_end)
          values (2, 'published', now(), ${NOW}, ${NOW})`,
    ).rejects.toThrow(/check/);
    await expect(
      sql`update issue set title = ${"x".repeat(201)} where id = ${issueId}`,
    ).rejects.toThrow(/check/);
    await expect(
      sql`update issue set intro = ${"x".repeat(4001)} where id = ${issueId}`,
    ).rejects.toThrow(/check/);

    const eventId = await seedEvent("a", daysAgo(1));
    await expect(
      sql`insert into issue_item (issue_id, event_id, position, section)
          values (${issueId}, ${eventId}, 1, 'sidebar')`,
    ).rejects.toThrow(/check/);
    await sql`insert into issue_item (issue_id, event_id, position, section)
              values (${issueId}, ${eventId}, 1, 'watch')`;
    await expect(
      sql`update issue_item set note = ${"x".repeat(2001)} where issue_id = ${issueId}`,
    ).rejects.toThrow(/check/);
    await sql`update issue_item set note = ${"x".repeat(2000)} where issue_id = ${issueId}`;
  });

  it("rejects the same event twice and the same position twice in one issue", async () => {
    const { issueId } = await openIssue(sql, NOW);
    const a = await seedEvent("a", daysAgo(1));
    const b = await seedEvent("b", daysAgo(1));
    await sql`insert into issue_item (issue_id, event_id, position, section)
              values (${issueId}, ${a}, 1, 'watch')`;
    await expect(
      sql`insert into issue_item (issue_id, event_id, position, section)
          values (${issueId}, ${a}, 2, 'watch')`,
    ).rejects.toThrow(/duplicate key/);
    await expect(
      sql`insert into issue_item (issue_id, event_id, position, section)
          values (${issueId}, ${b}, 1, 'watch')`,
    ).rejects.toThrow(/duplicate key/);
  });

  it("refuses to delete a change_event that an issue item points at", async () => {
    const eventId = await seedEvent("a", daysAgo(1));
    await openIssue(sql, NOW);
    await expect(sql`delete from change_event where id = ${eventId}`).rejects.toThrow(
      /foreign key/,
    );
  });

  it("records a sent delivery once per issue, subscriber and channel", async () => {
    const { issueId } = await openIssue(sql, NOW);
    const subscribers = await sql<{ id: string }[]>`
      insert into subscriber (email) values ('a@example.com') returning id
    `;
    const subscriberId = subscribers[0]!.id;
    await sql`insert into issue_delivery (issue_id, subscriber_id, channel, status)
              values (${issueId}, ${subscriberId}, 'email', 'failed')`;
    await sql`insert into issue_delivery (issue_id, subscriber_id, channel, status)
              values (${issueId}, ${subscriberId}, 'email', 'failed')`;
    await sql`insert into issue_delivery (issue_id, subscriber_id, channel, status)
              values (${issueId}, ${subscriberId}, 'email', 'sent')`;
    await expect(
      sql`insert into issue_delivery (issue_id, subscriber_id, channel, status)
          values (${issueId}, ${subscriberId}, 'email', 'sent')`,
    ).rejects.toThrow(/issue_delivery_sent_once_idx/);
  });
});

describe("issue tables are closed to API roles", () => {
  it("has row level security on and no grants for anon", async () => {
    const tables = await sql<{ relname: string; relrowsecurity: boolean; readable: boolean }[]>`
      select c.relname, c.relrowsecurity, has_table_privilege('anon', c.oid, 'select') as readable
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('issue', 'issue_item', 'issue_delivery')
      order by c.relname
    `;
    expect(tables).toEqual([
      { relname: "issue", relrowsecurity: true, readable: false },
      { relname: "issue_delivery", relrowsecurity: true, readable: false },
      { relname: "issue_item", relrowsecurity: true, readable: false },
    ]);
    expect(
      await sql`select count(*)::int as n from pg_policies where tablename like 'issue%'`,
    ).toMatchObject([{ n: 0 }]);
  });
});
