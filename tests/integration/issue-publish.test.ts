// Slice G.4 outer test: `issue publish` flips the draft, sends the issue once to
// every confirmed subscriber, and only ever retries what failed. Real Postgres
// and the local mail catcher.
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { MAILPIT_API_URL, MAILPIT_SMTP_URL } from "../../scripts/dev-mail.ts";
import { runIssuePublish, runIssueRetry } from "../../src/cli/issue.ts";
import type { CandidateEvent } from "../../src/core/types.ts";
import type { SendEmail } from "../../src/delivery/email.ts";
import { createSmtpSender } from "../../src/delivery/smtp.ts";
import { connect } from "../../src/store/db.ts";
import {
  annotateItem,
  getDraftIssue,
  includeEvent,
  openIssue,
  publishDraft,
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

const retry = async (send?: SendEmail) => {
  const lines: string[] = [];
  const ok = await runIssueRetry(sql, deps(send), (line) => lines.push(line));
  return { ok, lines };
};

/** A sender that records what it was asked to send and never touches the network. */
const recorder = (failFor: string[] = []) => {
  const sent: { to: string; subject: string }[] = [];
  const send: SendEmail = async (message) => {
    if (failFor.includes(message.to)) throw new Error("421 try again later");
    sent.push({ to: message.to, subject: message.subject });
  };
  return { sent, send };
};

const mustNotSend: SendEmail = async () => {
  throw new Error("must not send");
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

const TITLE = "Anchors land";

/** A draft carrying one annotated event and a title, ready to publish. */
const openAnnotatedDraft = async () => {
  await ingestCandidates(sql, [candidate("lh")]);
  await openIssue(sql);
  const draft = (await getDraftIssue(sql))!;
  await annotateItem(sql, draft.id, draft.items[0]!.event.id, "Worth reading.", "lead");
  await setHeading(sql, draft.id, TITLE, "");
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
      expect((await inbox())[0]!.Subject).toBe(`Platform Pulse #1: ${TITLE}`);
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
    const draft = (await getDraftIssue(sql))!;
    await setHeading(sql, draft.id, TITLE, "");

    const { ok, lines } = await publish();

    expect(ok).toBe(true);
    expect(lines.some((line) => line.startsWith("warning: no included item has a note"))).toBe(
      true,
    );
    const [message] = await inbox();
    expect(message!.Subject).toBe(`Platform Pulse #1: ${TITLE}`);
    const { id } = await bodyOf("alice@example.com");
    const html = (
      (await (await fetch(`${MAILPIT_API_URL}/api/v1/message/${id}`)).json()) as { HTML: string }
    ).HTML;
    expect(html).not.toContain("issue-preview-banner");
  });

  it("publishes a draft that has a title and an intro but no items", SLOW_SMTP, async () => {
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

  it("refuses when there is no draft, says which command retries, and sends nothing", async () => {
    await signUp("alice@example.com");

    const { ok, lines } = await publish(mustNotSend);

    expect(ok).toBe(false);
    expect(lines.join("\n")).toMatch(/no draft issue to publish/);
    expect(lines.join("\n")).toContain("`issue retry`");
  });

  it("refuses to publish when the only draft is already published, rather than resending", async () => {
    await signUp("alice@example.com");
    await openAnnotatedDraft();
    const first = recorder();
    expect((await publish(first.send)).ok).toBe(true);

    const again = recorder();
    const { ok, lines } = await publish(again.send);

    expect(ok).toBe(false);
    expect(lines.join("\n")).toMatch(/no draft issue to publish/);
    expect(again.sent).toEqual([]);
  });

  it("refuses a draft with a title but no items and no intro, and leaves it a draft", async () => {
    await signUp("alice@example.com");
    await openIssue(sql);
    const draft = (await getDraftIssue(sql))!;
    await setHeading(sql, draft.id, TITLE, "");

    const { ok, lines } = await publish(mustNotSend);

    expect(ok).toBe(false);
    expect(lines.join("\n")).toMatch(
      /was not published: it needs at least one included item or an intro/,
    );
    const [issue] = await sql`select status, published_at from issue`;
    expect(issue).toMatchObject({ status: "draft", published_at: null });
    expect(await sql`select id from issue_delivery`).toHaveLength(0);
  });

  it("refuses a draft whose items were all excluded and whose intro is blank", async () => {
    await ingestCandidates(sql, [candidate("lh")]);
    await openIssue(sql);
    const draft = (await getDraftIssue(sql))!;
    await sql`select public.issue_exclude_event(${draft.id}::uuid, ${draft.items[0]!.event.id}::uuid)`;
    await setHeading(sql, draft.id, TITLE, "   ");

    expect((await publish(mustNotSend)).ok).toBe(false);
    const [issue] = await sql`select status from issue`;
    expect(issue!.status).toBe("draft");
  });

  it("refuses a draft with annotated items but a blank title, and leaves it a draft", async () => {
    await signUp("alice@example.com");
    await ingestCandidates(sql, [candidate("lh")]);
    await openIssue(sql);
    const draft = (await getDraftIssue(sql))!;
    await annotateItem(sql, draft.id, draft.items[0]!.event.id, "Worth reading.", "lead");
    await setHeading(sql, draft.id, "   ", "A real intro.");

    const { ok, lines } = await publish(mustNotSend);

    expect(ok).toBe(false);
    expect(lines.join("\n")).toMatch(/was not published: it needs a title\./);
    expect(await sql`select status, published_at from issue`).toMatchObject([
      { status: "draft", published_at: null },
    ]);
    expect(await sql`select id from issue_delivery`).toHaveLength(0);
  });

  it("enforces the title rule in the update itself, not only in the command", async () => {
    await ingestCandidates(sql, [candidate("lh")]);
    await openIssue(sql);

    expect(await publishDraft(sql)).toEqual({
      outcome: "refused",
      number: 1,
      missing: ["title"],
    });
    expect(await sql`select status from issue`).toMatchObject([{ status: "draft" }]);
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

describe("issue retry", () => {
  it("sends nothing and changes nothing when everyone has the issue", SLOW_SMTP, async () => {
    await signUp("alice@example.com");
    await openAnnotatedDraft();
    await publish();
    const before = await sql`select id, status, published_at from issue`;
    const deliveriesBefore = await sql`select id from issue_delivery order by id`;

    const { ok, lines } = await retry();

    expect(ok).toBe(true);
    expect(lines.join("\n")).toMatch(/nothing is waiting/);
    expect(await sql`select id, status, published_at from issue`).toEqual(before);
    expect(await sql`select id from issue_delivery order by id`).toEqual(deliveriesBefore);
    expect(await inbox()).toHaveLength(1);
  });

  it("says so, and exits clean, when no issue has been published", async () => {
    await openIssue(sql);

    const { ok, lines } = await retry(mustNotSend);

    expect(ok).toBe(true);
    expect(lines.join("\n")).toMatch(/no published issue/);
    expect(await sql`select status from issue`).toMatchObject([{ status: "draft" }]);
  });

  it(
    "does not mail someone who confirms after publication, even on a later retry",
    SLOW_SMTP,
    async () => {
      await signUp("early@example.com");
      await openAnnotatedDraft();
      await publish();
      await fetch(`${MAILPIT_API_URL}/api/v1/messages`, { method: "DELETE" });

      await signUp("late@example.com");
      const { ok, lines } = await retry();

      expect(ok).toBe(true);
      expect(lines.join("\n")).toMatch(/nothing is waiting/);
      expect(await inbox()).toHaveLength(0);
      expect(await deliveries("late@example.com")).toEqual([]);
    },
  );

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

      const second = await retry();

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

    expect((await publish(failingFor("bob@example.com"))).ok).toBe(false);
    for (let attempt = 1; attempt < MAX_FAILED_DELIVERIES; attempt += 1) {
      expect((await retry(failingFor("bob@example.com"))).ok).toBe(false);
    }
    await retry(mustNotSend);

    expect(await deliveries("bob@example.com")).toHaveLength(MAX_FAILED_DELIVERIES);
  });

  // The review's scenario. The Sunday schedule opens next week's draft while an
  // older issue still has a failed send; retrying must reach the older issue
  // and must not publish the draft nobody has written yet.
  it("retries an older issue's failed send while the next draft is open, and publishes nothing", async () => {
    await signUp("alice@example.com");
    await signUp("bob@example.com");
    await ingestCandidates(sql, [candidate("week1")]);
    const week1End = new Date(Date.now() + 1_000);
    await openIssue(sql, week1End);
    const first = (await getDraftIssue(sql))!;
    await setHeading(sql, first.id, "Week one", "Intro.");
    const failing = recorder(["bob@example.com"]);
    expect((await publish(failing.send)).ok).toBe(false);
    expect(failing.sent.map((m) => m.to)).toEqual(["alice@example.com"]);

    // The schedule cuts draft 2 with an event of its own, pre-filled and untitled.
    await ingestCandidates(sql, [candidate("week2")]);
    await sql`
      update change_event set first_observed_at = ${new Date(week1End.getTime() + 1_000)}
      where dedupe_key = 'test:week2'
    `;
    await openIssue(sql, new Date(week1End.getTime() + 5_000));

    const working = recorder();
    const { ok, lines } = await retry(working.send);

    expect(ok).toBe(true);
    expect(working.sent).toEqual([
      { to: "bob@example.com", subject: "Platform Pulse #1: Week one" },
    ]);
    expect(lines).toContain("issue #1: 1 sent, 0 failed");
    expect(await sql`select number, status from issue order by number`).toEqual([
      { number: 1, status: "published" },
      { number: 2, status: "draft" },
    ]);
    expect(
      await sql`select id from issue_delivery where issue_id = (select id from issue where number = 2)`,
    ).toHaveLength(0);

    // And publish on that untouched draft is refused, so the retry command is
    // the only way a retry can be asked for.
    const refused = await publish(mustNotSend);
    expect(refused.ok).toBe(false);
    expect(refused.lines.join("\n")).toMatch(/issue #2 was not published: it needs a title\./);
    expect(await sql`select number, status from issue order by number`).toEqual([
      { number: 1, status: "published" },
      { number: 2, status: "draft" },
    ]);
  });

  it("sends every older issue's owed emails oldest first, and each issue its own content", async () => {
    await signUp("alice@example.com");
    await signUp("bob@example.com");
    await ingestCandidates(sql, [candidate("week1")]);
    const week1End = new Date(Date.now() + 1_000);
    await openIssue(sql, week1End);
    const first = (await getDraftIssue(sql))!;
    await setHeading(sql, first.id, "Week one", "Intro.");
    expect((await publish(recorder(["bob@example.com"]).send)).ok).toBe(false);

    await openIssue(sql, new Date(week1End.getTime() + 5_000));
    const second = (await getDraftIssue(sql))!;
    await setHeading(sql, second.id, "Week two", "Another intro.");
    const failing = recorder(["alice@example.com", "bob@example.com"]);
    expect((await publish(failing.send)).ok).toBe(false);
    expect(failing.sent).toEqual([]);

    const working = recorder();
    expect((await retry(working.send)).ok).toBe(true);

    expect(working.sent).toEqual([
      { to: "bob@example.com", subject: "Platform Pulse #1: Week one" },
      { to: "alice@example.com", subject: "Platform Pulse #2: Week two" },
      { to: "bob@example.com", subject: "Platform Pulse #2: Week two" },
    ]);
  });
});

describe("issue publish after an older issue failed", () => {
  it("publishes the titled draft and also retries the older issue's failed send", async () => {
    await signUp("alice@example.com");
    await signUp("bob@example.com");
    await ingestCandidates(sql, [candidate("week1")]);
    const week1End = new Date(Date.now() + 1_000);
    await openIssue(sql, week1End);
    const first = (await getDraftIssue(sql))!;
    await setHeading(sql, first.id, "Week one", "Intro.");
    expect((await publish(recorder(["bob@example.com"]).send)).ok).toBe(false);

    await openIssue(sql, new Date(week1End.getTime() + 5_000));
    const second = (await getDraftIssue(sql))!;
    await setHeading(sql, second.id, "Week two", "Another intro.");

    const working = recorder();
    const { ok, lines } = await publish(working.send);

    expect(ok).toBe(true);
    expect(lines).toContain("issue #2 published");
    // The older issue first, so a subscriber who missed it gets it before its successor.
    expect(working.sent).toEqual([
      { to: "bob@example.com", subject: "Platform Pulse #1: Week one" },
      { to: "alice@example.com", subject: "Platform Pulse #2: Week two" },
      { to: "bob@example.com", subject: "Platform Pulse #2: Week two" },
    ]);
    expect(lines).toContain("issue #1: 1 sent, 0 failed");
    expect(lines).toContain("issue #2: 2 sent, 0 failed");
    expect(await sql`select number, status from issue order by number`).toEqual([
      { number: 1, status: "published" },
      { number: 2, status: "published" },
    ]);
  });
});
