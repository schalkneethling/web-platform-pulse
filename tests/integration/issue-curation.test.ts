import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { SECTION_ORDER, sectionFor } from "../../src/core/issue.ts";
import type { CandidateEvent, ChangeEventType } from "../../src/core/types.ts";
import { connect } from "../../src/store/db.ts";
import {
  annotateItem,
  excludeEvent,
  getDraftIssue,
  includeEvent,
  openIssue,
  setHeading,
} from "../../src/store/issue.ts";
import { CADENCE_PERIOD_MS, ensureSource, ingestCandidates } from "../../src/store/store.ts";

const sql = connect();

const NOW = new Date("2026-06-14T06:00:00.000Z");
const DAY = CADENCE_PERIOD_MS["daily"]!;
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY);

const EVENT_TYPES: ChangeEventType[] = [
  "baseline-change",
  "browser-support",
  "spec-change",
  "vendor-position",
  "feature-status",
  "browser-release",
  "runtime-release",
  "tag-review",
  "editorial",
];

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

const openEmptyDraft = async (): Promise<string> => (await openIssue(sql, NOW)).issueId;

const publish = async (issueId: string): Promise<void> => {
  await sql`update issue set status = 'published', published_at = now() where id = ${issueId}`;
};

beforeEach(async () => {
  await sql`truncate issue, issue_item, issue_delivery, change_event, event_source, digest, digest_item, source_state, subscription, subscriber restart identity cascade`;
  await ensureSource(sql, "web-features", "artifact-diff");
});

afterAll(async () => {
  await sql.end();
});

const itemFor = async (issueId: string, eventId: string) =>
  (
    await sql<{ position: number; section: string; note: string | null; included: boolean }[]>`
      select position, section, note, included from issue_item
      where issue_id = ${issueId} and event_id = ${eventId}
    `
  )[0];

describe("include and exclude", () => {
  it("excludes by flag and re-includes with the note intact", async () => {
    const eventId = await seedEvent("a", daysAgo(1));
    const issueId = await openEmptyDraft();
    await annotateItem(sql, issueId, eventId, "Why this matters", "lead");

    await excludeEvent(sql, issueId, eventId);
    expect(await itemFor(issueId, eventId)).toMatchObject({ included: false });

    await includeEvent(sql, issueId, eventId);
    expect(await itemFor(issueId, eventId)).toMatchObject({
      included: true,
      note: "Why this matters",
      section: "lead",
    });
    expect(await sql`select count(*)::int as n from issue_item`).toMatchObject([{ n: 1 }]);
  });

  it("rejects an event observed outside the window, treating the end as exclusive", async () => {
    // The draft is opened first so its window is fixed; seed the rest after.
    const issueId = await openEmptyDraft();
    const before = await seedEvent("before", new Date(NOW.getTime() - 7 * DAY - 1));
    const atEnd = await seedEvent("at-end", NOW);
    const atStart = await seedEvent("at-start", new Date(NOW.getTime() - 7 * DAY));

    await expect(includeEvent(sql, issueId, before)).rejects.toThrow(/not observed in the window/);
    await expect(includeEvent(sql, issueId, atEnd)).rejects.toThrow(/not observed in the window/);
    await includeEvent(sql, issueId, atStart);
    expect(await sql`select count(*)::int as n from issue_item`).toMatchObject([{ n: 1 }]);
  });

  it("rejects an event that does not exist", async () => {
    const issueId = await openEmptyDraft();
    await expect(
      includeEvent(sql, issueId, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(/does not exist/);
  });

  it("appends a new inclusion at max(position) + 1 in the section its type maps to", async () => {
    await seedEvent("first", daysAgo(1));
    await seedEvent("second", daysAgo(2), { type: "spec-change", taxonomy: ["html"] });
    const issueId = await openEmptyDraft();
    const late = await seedEvent("late", daysAgo(3), { type: "editorial", taxonomy: ["voices"] });
    await includeEvent(sql, issueId, late);

    const item = await itemFor(issueId, late);
    expect(item).toMatchObject({ position: 3, section: "voices", included: true, note: null });
  });

  it("appends after the highest position even when positions are not contiguous", async () => {
    await seedEvent("first", daysAgo(1));
    const issueId = await openEmptyDraft();
    await sql`update issue_item set position = 10 where issue_id = ${issueId}`;
    const late = await seedEvent("late", daysAgo(2));
    await includeEvent(sql, issueId, late);
    expect((await itemFor(issueId, late))?.position).toBe(11);
  });

  it("starts at position 1 in an empty issue", async () => {
    const issueId = await openEmptyDraft();
    const eventId = await seedEvent("a", daysAgo(1));
    await includeEvent(sql, issueId, eventId);
    expect(await itemFor(issueId, eventId)).toMatchObject({ position: 1, section: "shipped" });
  });

  it("treats excluding an event that was never an item as a no-op", async () => {
    const issueId = await openEmptyDraft();
    const eventId = await seedEvent("a", daysAgo(1));
    await excludeEvent(sql, issueId, eventId);
    expect(await sql`select count(*)::int as n from issue_item`).toMatchObject([{ n: 0 }]);
  });

  it("maps every event type to the section sectionFor assigns below the lead", async () => {
    const issueId = await openEmptyDraft();
    for (const type of EVENT_TYPES) {
      const eventId = await seedEvent(type, daysAgo(1), { type });
      await includeEvent(sql, issueId, eventId);
      expect((await itemFor(issueId, eventId))?.section, type).toBe(sectionFor({ type }, false));
    }
  });
});

describe("annotateItem", () => {
  it("trims the note and stores a blank one as null", async () => {
    const eventId = await seedEvent("a", daysAgo(1));
    const issueId = await openEmptyDraft();
    await includeEvent(sql, issueId, eventId);

    await annotateItem(sql, issueId, eventId, "  A sentence.\n", "watch");
    expect(await itemFor(issueId, eventId)).toMatchObject({
      note: "A sentence.",
      section: "watch",
    });

    await annotateItem(sql, issueId, eventId, "   \n ", "watch");
    expect((await itemFor(issueId, eventId))?.note).toBeNull();
  });

  it("accepts every section in SECTION_ORDER and rejects an unknown one", async () => {
    const eventId = await seedEvent("a", daysAgo(1));
    const issueId = await openEmptyDraft();
    await includeEvent(sql, issueId, eventId);
    for (const section of SECTION_ORDER) {
      await annotateItem(sql, issueId, eventId, null, section);
    }
    await expect(
      sql`select public.issue_annotate_item(${issueId}::uuid, ${eventId}::uuid, null, 'sidebar')`,
    ).rejects.toThrow(/issue_item_section_check/);
  });

  it("rejects a note over 2000 characters and keeps one of exactly 2000", async () => {
    const eventId = await seedEvent("a", daysAgo(1));
    const issueId = await openEmptyDraft();
    await includeEvent(sql, issueId, eventId);

    await annotateItem(sql, issueId, eventId, "x".repeat(2000), "watch");
    await expect(annotateItem(sql, issueId, eventId, "x".repeat(2001), "watch")).rejects.toThrow(
      /issue_item_note_check/,
    );
    expect((await itemFor(issueId, eventId))?.note).toHaveLength(2000);
  });

  it("rejects an event that is not an item", async () => {
    const issueId = await openEmptyDraft();
    const eventId = await seedEvent("a", daysAgo(1));
    await expect(annotateItem(sql, issueId, eventId, "note", "watch")).rejects.toThrow(
      /is not an item of this issue/,
    );
  });

  it("annotates an excluded item without including it", async () => {
    const eventId = await seedEvent("a", daysAgo(1));
    const issueId = await openEmptyDraft();
    await includeEvent(sql, issueId, eventId);
    await excludeEvent(sql, issueId, eventId);
    await annotateItem(sql, issueId, eventId, "Keep this", "watch");
    expect(await itemFor(issueId, eventId)).toMatchObject({ included: false, note: "Keep this" });
  });
});

describe("setHeading", () => {
  it("sets the title and intro, trimmed, visible through getDraftIssue", async () => {
    const issueId = await openEmptyDraft();
    await setHeading(sql, issueId, "  Container queries land ", "Intro.\n\nSecond paragraph.\n");
    expect(await getDraftIssue(sql)).toMatchObject({
      title: "Container queries land",
      intro: "Intro.\n\nSecond paragraph.",
    });
  });

  it("enforces the caps of 200 and 4000 characters", async () => {
    const issueId = await openEmptyDraft();
    await setHeading(sql, issueId, "t".repeat(200), "i".repeat(4000));
    await expect(setHeading(sql, issueId, "t".repeat(201), "")).rejects.toThrow(
      /issue_title_check/,
    );
    await expect(setHeading(sql, issueId, "", "i".repeat(4001))).rejects.toThrow(
      /issue_intro_check/,
    );
  });
});

describe("a published issue is read-only", () => {
  it("rejects every write function and changes nothing", async () => {
    const eventId = await seedEvent("a", daysAgo(1));
    const issueId = await openEmptyDraft();
    const spare = await seedEvent("b", daysAgo(1));
    await annotateItem(sql, issueId, eventId, "Original", "watch");
    await setHeading(sql, issueId, "Original title", "Original intro");
    await publish(issueId);

    const rejected = /is published and can no longer be edited/;
    await expect(includeEvent(sql, issueId, spare)).rejects.toThrow(rejected);
    await expect(excludeEvent(sql, issueId, eventId)).rejects.toThrow(rejected);
    await expect(annotateItem(sql, issueId, eventId, "Edited", "lead")).rejects.toThrow(rejected);
    await expect(setHeading(sql, issueId, "Edited", "Edited")).rejects.toThrow(rejected);

    expect(await itemFor(issueId, eventId)).toMatchObject({
      included: true,
      note: "Original",
      section: "watch",
    });
    expect(await itemFor(issueId, spare)).toBeUndefined();
    expect(await sql`select title, intro from issue`).toMatchObject([
      { title: "Original title", intro: "Original intro" },
    ]);
  });

  it("rejects an issue that does not exist", async () => {
    await expect(setHeading(sql, "00000000-0000-0000-0000-000000000000", "t", "i")).rejects.toThrow(
      /does not exist/,
    );
  });
});
