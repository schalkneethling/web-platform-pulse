// Slice G.3 outer test: `issue preview` lands in the local mail catcher through
// the real issue template, and changes nothing in the database.
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { MAILPIT_API_URL, MAILPIT_SMTP_URL } from "../../scripts/dev-mail.ts";
import { runIssuePreview } from "../../src/cli/issue.ts";
import { createSmtpSender } from "../../src/delivery/smtp.ts";
import { connect } from "../../src/store/db.ts";
import { annotateItem, getDraftIssue, openIssue } from "../../src/store/issue.ts";
import { ensureSource, ingestCandidates } from "../../src/store/store.ts";

const sql = connect();

const deps = {
  send: createSmtpSender(MAILPIT_SMTP_URL),
  from: "Platform Pulse <pulse@localhost>",
  to: "operator@example.com",
  publicUrl: "https://pulse.example.com",
};

const inbox = async (): Promise<{ total: number; messages: { ID: string; Subject: string }[] }> =>
  (await fetch(`${MAILPIT_API_URL}/api/v1/messages`)).json() as never;

const bodies = async (id: string): Promise<{ HTML: string; Text: string }> =>
  (await fetch(`${MAILPIT_API_URL}/api/v1/message/${id}`)).json() as never;

const snapshot = async () => ({
  issues: await sql`select id, status, published_at, title, intro from issue order by number`,
  items: await sql`select event_id, note, included, section from issue_item order by position`,
  deliveries: await sql`select count(*)::int as n from issue_delivery`,
});

beforeEach(async () => {
  await sql`truncate issue, issue_item, issue_delivery, change_event, event_source, source_state restart identity cascade`;
  await ensureSource(sql, "web-features", "artifact-diff");
  await fetch(`${MAILPIT_API_URL}/api/v1/messages`, { method: "DELETE" });
});

afterAll(async () => {
  await sql.end();
});

// See delivery.test.ts: the first SMTP response from the Dockerized catcher can
// be held for about 10 seconds on some machines.
const SLOW_SMTP = { timeout: 40_000 };

const ingestOne = () =>
  ingestCandidates(sql, [
    {
      type: "baseline-change",
      subject: { kind: "feature", id: "lh" },
      title: "lh reached Baseline",
      before: null,
      after: { baseline: "high" },
      occurredAt: null,
      taxonomy: ["css"],
      dedupeKey: "test:lh",
      correlationKey: "test:lh",
      provenance: [
        {
          sourceId: "web-features",
          url: "https://example.com/lh",
          title: "lh",
          observedAt: new Date().toISOString(),
        },
      ],
    },
  ]);

describe("issue preview", () => {
  it(
    "arrives with the banner until an item is annotated, and writes nothing",
    SLOW_SMTP,
    async () => {
      await ingestOne();
      await openIssue(sql);
      const before = await snapshot();

      expect(await runIssuePreview(sql, deps, () => {})).toBe(true);
      let { total, messages } = await inbox();
      expect(total).toBe(1);
      expect(messages[0]!.Subject).toBe("[Preview] Platform Pulse #1");
      let { HTML, Text } = await bodies(messages[0]!.ID);
      expect(HTML).toContain("issue-preview-banner");
      expect(HTML).toContain("lh reached Baseline");
      expect(Text).toContain("https://example.com/lh");
      expect(HTML).toContain("/unsubscribe?token=00000000-0000-0000-0000-000000000000");
      expect(await snapshot()).toEqual(before);

      const draft = (await getDraftIssue(sql))!;
      await annotateItem(sql, draft.id, draft.items[0]!.event.id, "Worth reading.", "lead");
      const annotated = await snapshot();
      await fetch(`${MAILPIT_API_URL}/api/v1/messages`, { method: "DELETE" });

      expect(await runIssuePreview(sql, deps, () => {})).toBe(true);
      ({ total, messages } = await inbox());
      expect(total).toBe(1);
      ({ HTML, Text } = await bodies(messages[0]!.ID));
      expect(HTML).not.toContain("issue-preview-banner");
      expect(HTML).toContain("Worth reading.");
      expect(Text).toContain("Worth reading.");
      expect(await snapshot()).toEqual(annotated);

      const [issue] = await sql`select status, published_at from issue`;
      expect(issue).toMatchObject({ status: "draft", published_at: null });
    },
  );

  it("fails clearly and sends nothing when there is no draft", SLOW_SMTP, async () => {
    const lines: string[] = [];
    expect(await runIssuePreview(sql, deps, (line) => lines.push(line))).toBe(false);
    expect(lines.join("\n")).toMatch(/no draft issue/i);
    expect((await inbox()).total).toBe(0);
  });
});
