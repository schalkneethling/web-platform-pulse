// Slice G.4 outer test: `issue publish` flips the draft, sends the issue once to
// every confirmed subscriber, and only ever retries what failed. Real Postgres
// and the local mail catcher.
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { MAILPIT_API_URL, MAILPIT_SMTP_URL } from "../../scripts/dev-mail.ts";
import { runIssuePublish } from "../../src/cli/issue.ts";
import type { CandidateEvent } from "../../src/core/types.ts";
import type { SendEmail } from "../../src/delivery/email.ts";
import { createSmtpSender } from "../../src/delivery/smtp.ts";
import { connect } from "../../src/store/db.ts";
import {
  annotateItem,
  getDraftIssue,
  includeEvent,
  openIssue,
  setHeading,
} from "../../src/store/issue.ts";
import {
  confirmSubscription,
  ensureSource,
  ingestCandidates,
  MAX_FAILED_DELIVERIES,
  requestSubscription,
  unsubscribe,
} from "../../src/store/store.ts";

const sql = connect();

const PUBLIC_URL = "https://pulse.example.com";
const smtp = createSmtpSender(MAILPIT_SMTP_URL);

const deps = (send: SendEmail = smtp) => ({
  send,
  from: "Platform Pulse <pulse@localhost>",
  publicUrl: PUBLIC_URL,
});

const publish = async (send?: SendEmail) => {
  const lines: string[] = [];
  const ok = await runIssuePublish(sql, deps(send), (line) => lines.push(line));
  return { ok, lines };
};

/** Fails for the named addresses with an error that echoes a credentialed URL. */
const failingFor =
  (...addresses: string[]): SendEmail =>
  async (message) => {
    if (addresses.includes(message.to)) {
      throw new Error("connect ECONNREFUSED smtp://user:hunter2@smtp.example.com:587");
    }
    await smtp(message);
  };

const candidate = (id: string): CandidateEvent => ({
  type: "baseline-change",
  subject: { kind: "feature", id },
  title: `${id} reached Baseline`,
  before: null,
  after: { baseline: "high" },
  occurredAt: null,
  taxonomy: ["css"],
  dedupeKey: `test:${id}`,
  correlationKey: `test:${id}`,
  provenance: [
    {
      sourceId: "web-features",
      url: `https://example.com/${id}`,
      title: id,
      observedAt: new Date().toISOString(),
    },
  ],
});

const signUp = async (email: string): Promise<string> => {
  await requestSubscription(sql, email);
  const [row] = await sql<{ id: string; confirm_token: string }[]>`
    select id, confirm_token from subscriber where email = ${email}
  `;
  await confirmSubscription(sql, row!.confirm_token);
  return row!.id;
};

const tokenOf = async (email: string): Promise<string> => {
  const [row] = await sql<{ unsubscribe_token: string }[]>`
    select unsubscribe_token from subscriber where email = ${email}
  `;
  return row!.unsubscribe_token;
};

interface InboxMessage {
  ID: string;
  To: { Address: string }[];
  Subject: string;
}

const inbox = async (): Promise<InboxMessage[]> =>
  (
    (await (await fetch(`${MAILPIT_API_URL}/api/v1/messages`)).json()) as {
      messages: InboxMessage[];
    }
  ).messages;

const recipients = async (): Promise<string[]> =>
  (await inbox()).map((message) => message.To[0]!.Address).sort();

const bodyOf = async (address: string): Promise<{ id: string; text: string }> => {
  const message = (await inbox()).find((m) => m.To[0]!.Address === address)!;
  const body = (await (await fetch(`${MAILPIT_API_URL}/api/v1/message/${message.ID}`)).json()) as {
    Text: string;
  };
  return { id: message.ID, text: body.Text };
};

const deliveries = async (email: string) =>
  sql<{ status: string; error: string | null }[]>`
    select d.status, d.error from issue_delivery d join subscriber s on s.id = d.subscriber_id
    where s.email = ${email} order by d.attempted_at, d.id
  `;

/** A draft carrying one annotated event, ready to publish. */
const openAnnotatedDraft = async () => {
  await ingestCandidates(sql, [candidate("lh")]);
  await openIssue(sql);
  const draft = (await getDraftIssue(sql))!;
  await annotateItem(sql, draft.id, draft.items[0]!.event.id, "Worth reading.", "lead");
  return draft;
};

beforeEach(async () => {
  await sql`truncate issue, issue_item, issue_delivery, change_event, event_source, source_state, subscription, subscriber restart identity cascade`;
  await ensureSource(sql, "web-features", "artifact-diff");
  await fetch(`${MAILPIT_API_URL}/api/v1/messages`, { method: "DELETE" });
});

afterAll(async () => {
  await sql.end();
});

// See delivery.test.ts: the first SMTP response from the Dockerized catcher can
// be held for about 10 seconds on some machines.
const SLOW_SMTP = { timeout: 40_000 };

describe("issue publish", () => {
  it(
    "flips the draft, stamps published_at and mails each confirmed subscriber once, whatever their filters",
    SLOW_SMTP,
    async () => {
      const aliceId = await signUp("alice@example.com");
      await signUp("bob@example.com");
      await requestSubscription(sql, "pending@example.com");
      await signUp("gone@example.com");
      await unsubscribe(sql, await tokenOf("gone@example.com"));
      // Alice's subscription would exclude every item from her daily digest.
      await sql`
        update subscription set taxonomies = ${["javascript"]}, significance_floor = 1
        where subscriber_id = ${aliceId}
      `;
      await openAnnotatedDraft();

      const { ok, lines } = await publish();

      expect(ok).toBe(true);
      expect(lines).toContain("issue #1 published");
      expect(lines).toContain("issue #1: 2 sent, 0 failed");
      const [issue] = await sql`select status, published_at from issue`;
      expect(issue!.status).toBe("published");
      expect(issue!.published_at).toBeInstanceOf(Date);
      expect(await recipients()).toEqual(["alice@example.com", "bob@example.com"]);
      expect((await bodyOf("alice@example.com")).text).toContain("lh reached Baseline");
      expect((await inbox())[0]!.Subject).toBe("Platform Pulse #1");
    },
  );

  it("sends each recipient their own unsubscribe link and header", SLOW_SMTP, async () => {
    await signUp("alice@example.com");
    await signUp("bob@example.com");
    await openAnnotatedDraft();

    await publish();

    const aliceLink = `${PUBLIC_URL}/unsubscribe?token=${await tokenOf("alice@example.com")}`;
    const bobLink = `${PUBLIC_URL}/unsubscribe?token=${await tokenOf("bob@example.com")}`;
    const alice = await bodyOf("alice@example.com");
    const bob = await bodyOf("bob@example.com");
    expect(alice.text).toContain(aliceLink);
    expect(alice.text).not.toContain(bobLink);
    expect(bob.text).toContain(bobLink);
    expect(bob.text).not.toContain(aliceLink);
    const headers = (await (
      await fetch(`${MAILPIT_API_URL}/api/v1/message/${alice.id}/headers`)
    ).json()) as Record<string, string[]>;
    expect(headers["List-Unsubscribe"]).toEqual([`<${aliceLink}>`]);
  });

  it("never mails the preview banner or subject prefix", SLOW_SMTP, async () => {
    await signUp("alice@example.com");
    await ingestCandidates(sql, [candidate("lh")]);
    await openIssue(sql);

    const { ok, lines } = await publish();

    expect(ok).toBe(true);
    expect(lines.some((line) => line.startsWith("warning: no included item has a note"))).toBe(
      true,
    );
    const [message] = await inbox();
    expect(message!.Subject).toBe("Platform Pulse #1");
    const { id } = await bodyOf("alice@example.com");
    const html = (
      (await (await fetch(`${MAILPIT_API_URL}/api/v1/message/${id}`)).json()) as { HTML: string }
    ).HTML;
    expect(html).not.toContain("issue-preview-banner");
  });

  it(
    "does not mail someone who confirms after publication, even on a later run",
    SLOW_SMTP,
    async () => {
      await signUp("early@example.com");
      await openAnnotatedDraft();
      await publish();
      await fetch(`${MAILPIT_API_URL}/api/v1/messages`, { method: "DELETE" });

      await signUp("late@example.com");
      const { ok, lines } = await publish();

      expect(ok).toBe(true);
      expect(lines.join("\n")).toMatch(/already published and nothing is waiting/);
      expect(await inbox()).toHaveLength(0);
      expect(await deliveries("late@example.com")).toEqual([]);
    },
  );

  it("a second publish sends nothing and changes nothing", SLOW_SMTP, async () => {
    await signUp("alice@example.com");
    await openAnnotatedDraft();
    await publish();
    const before = await sql`select id, status, published_at from issue`;
    const deliveriesBefore = await sql`select id from issue_delivery order by id`;

    const { ok, lines } = await publish();

    expect(ok).toBe(true);
    expect(lines.join("\n")).toMatch(/nothing is waiting/);
    expect(await sql`select id, status, published_at from issue`).toEqual(before);
    expect(await sql`select id from issue_delivery order by id`).toEqual(deliveriesBefore);
    expect(await inbox()).toHaveLength(1);
  });

  it("says so, and exits clean, when no issue exists at all", async () => {
    const { ok, lines } = await publish(async () => {
      throw new Error("must not send");
    });
    expect(ok).toBe(true);
    expect(lines.join("\n")).toMatch(/nothing to retry/);
  });

  it(
    "records a failure with the credential scrubbed, exits non-zero and retries only that subscriber",
    SLOW_SMTP,
    async () => {
      await signUp("alice@example.com");
      await signUp("bob@example.com");
      await openAnnotatedDraft();

      const first = await publish(failingFor("bob@example.com"));

      expect(first.ok).toBe(false);
      expect(first.lines).toContain("issue #1: 1 sent, 1 failed");
      expect(await recipients()).toEqual(["alice@example.com"]);
      const [failure] = await deliveries("bob@example.com");
      expect(failure!.status).toBe("failed");
      expect(failure!.error).toContain("smtp://***@smtp.example.com");
      expect(failure!.error).not.toContain("hunter2");

      const second = await publish();

      expect(second.ok).toBe(true);
      expect(second.lines).toContain("issue #1: 1 sent, 0 failed");
      expect(await recipients()).toEqual(["alice@example.com", "bob@example.com"]);
      expect((await deliveries("bob@example.com")).map((row) => row.status)).toEqual([
        "failed",
        "sent",
      ]);
      expect((await deliveries("alice@example.com")).map((row) => row.status)).toEqual(["sent"]);
    },
  );

  it("stops retrying a subscriber after MAX_FAILED_DELIVERIES failures", async () => {
    await signUp("bob@example.com");
    await openAnnotatedDraft();

    for (let attempt = 0; attempt < MAX_FAILED_DELIVERIES; attempt += 1) {
      expect((await publish(failingFor("bob@example.com"))).ok).toBe(false);
    }
    const last = await publish(async () => {
      throw new Error("must not send");
    });

    expect(last.ok).toBe(true);
    expect(await deliveries("bob@example.com")).toHaveLength(MAX_FAILED_DELIVERIES);
  });

  it("refuses a draft with no items and no intro, and leaves it a draft", async () => {
    await signUp("alice@example.com");
    await openIssue(sql);

    const { ok, lines } = await publish(async () => {
      throw new Error("must not send");
    });

    expect(ok).toBe(false);
    expect(lines.join("\n")).toMatch(/was not published/);
    const [issue] = await sql`select status, published_at from issue`;
    expect(issue).toMatchObject({ status: "draft", published_at: null });
    expect(await sql`select id from issue_delivery`).toHaveLength(0);
  });

  it("refuses a draft whose items were all excluded and whose intro is blank", async () => {
    await ingestCandidates(sql, [candidate("lh")]);
    await openIssue(sql);
    const draft = (await getDraftIssue(sql))!;
    await sql`select public.issue_exclude_event(${draft.id}::uuid, ${draft.items[0]!.event.id}::uuid)`;
    await setHeading(sql, draft.id, "", "   ");

    expect((await publish()).ok).toBe(false);
    const [issue] = await sql`select status from issue`;
    expect(issue!.status).toBe("draft");
  });

  it("publishes a draft that has an intro and no items", SLOW_SMTP, async () => {
    await signUp("alice@example.com");
    await openIssue(sql);
    const draft = (await getDraftIssue(sql))!;
    await setHeading(sql, draft.id, "A quiet week", "Nothing shipped, but here is why.");

    const { ok } = await publish();

    expect(ok).toBe(true);
    const [message] = await inbox();
    expect(message!.Subject).toBe("Platform Pulse #1: A quiet week");
    expect((await bodyOf("alice@example.com")).text).toContain("Nothing shipped, but here is why.");
  });

  it("locks the issue against curation once published", SLOW_SMTP, async () => {
    const draft = await openAnnotatedDraft();
    await publish();

    await expect(includeEvent(sql, draft.id, draft.items[0]!.event.id)).rejects.toThrow(
      /published and can no longer be edited/,
    );
  });

  it("opens the next issue where the published one ended", SLOW_SMTP, async () => {
    const draft = await openAnnotatedDraft();
    await publish();

    await openIssue(sql);

    const [first, second] = await sql<{ number: number; window_start: Date; window_end: Date }[]>`
      select number, window_start, window_end from issue order by number
    `;
    expect(second!.number).toBe(2);
    expect(second!.window_start).toEqual(first!.window_end);
    expect(first!.window_end.toISOString()).toBe(draft.windowEnd);
  });
});
