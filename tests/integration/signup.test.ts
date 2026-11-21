// Slice F.8 outer test (§17): a visitor's email becomes an unconfirmed
// subscriber, and the pipeline mails them a confirmation link keyed on their
// confirm_token. Real Postgres and real Mailpit; the write path under test is
// the same request_subscription function the browser calls through PostgREST.
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { MAILPIT_API_URL, MAILPIT_SMTP_URL } from "../../scripts/dev-mail.ts";
import { sendPendingConfirmations } from "../../src/cli/confirmations.ts";
import { createSmtpSender } from "../../src/delivery/smtp.ts";
import { connect } from "../../src/store/db.ts";
import type { SendEmail } from "../../src/delivery/email.ts";
import { ensureOperator, requestSubscription } from "../../src/store/store.ts";

const sql = connect();

const FROM = "Platform Pulse <pulse@localhost>";
const PUBLIC_URL = "https://pulse.example.com";

const send = createSmtpSender(MAILPIT_SMTP_URL);
const sendConfirmations = (overrides: { limit?: number } = {}) =>
  sendPendingConfirmations(sql, { send, from: FROM, publicUrl: PUBLIC_URL, ...overrides });

const sendWith = (fake: SendEmail) =>
  sendPendingConfirmations(sql, { send: fake, from: FROM, publicUrl: PUBLIC_URL });

const rejecting: SendEmail = async () => {
  throw new Error("550 mailbox unavailable");
};
const accepting: SendEmail = async () => {};

interface InboxMessage {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

const inbox = async (): Promise<{ total: number; messages: InboxMessage[] }> => {
  const response = await fetch(`${MAILPIT_API_URL}/api/v1/messages`);
  return (await response.json()) as { total: number; messages: InboxMessage[] };
};

const messageBodies = async (id: string): Promise<{ HTML: string; Text: string }> => {
  const response = await fetch(`${MAILPIT_API_URL}/api/v1/message/${id}`);
  return (await response.json()) as { HTML: string; Text: string };
};

const subscribers = () => sql<
  {
    email: string;
    confirmed_at: Date | null;
    unsubscribed_at: Date | null;
    confirm_token: string;
    confirmation_sent_at: Date | null;
    confirmation_attempts: number;
  }[]
>`
  select email, confirmed_at, unsubscribed_at, confirm_token, confirmation_sent_at, confirmation_attempts
  from subscriber order by created_at
`;

beforeEach(async () => {
  await sql`truncate subscription, subscriber restart identity cascade`;
  await fetch(`${MAILPIT_API_URL}/api/v1/messages`, { method: "DELETE" });
});

afterAll(async () => {
  await sql.end();
});

// Generous timeouts: on some machines the first SMTP response from the
// Dockerized catcher is held ~10s by local network inspection before it
// reaches a Node socket (HTTP and Postgres on the same container are
// unaffected). nodemailer's default 30s greeting timeout absorbs it.
const SLOW_SMTP = { timeout: 40_000 };

describe("request_subscription", () => {
  it("creates an unconfirmed subscriber and one default subscription", async () => {
    await requestSubscription(sql, "new@example.com");

    expect(await subscribers()).toMatchObject([
      {
        email: "new@example.com",
        confirmed_at: null,
        unsubscribed_at: null,
        confirmation_sent_at: null,
        confirmation_attempts: 0,
      },
    ]);
    expect(await sql`select cadence from subscription`).toMatchObject([{ cadence: "daily" }]);
  });

  it("creates no duplicate on a repeat signup", async () => {
    await requestSubscription(sql, "new@example.com");
    await requestSubscription(sql, "new@example.com");

    expect(await subscribers()).toHaveLength(1);
    expect(await sql`select id from subscription`).toHaveLength(1);
  });

  it("treats a different-case address as the same subscriber", async () => {
    await requestSubscription(sql, "New@Example.com");
    await requestSubscription(sql, "  new@example.COM ");

    expect(await subscribers()).toMatchObject([{ email: "new@example.com" }]);
  });

  it("leaves a confirmed subscriber confirmed", async () => {
    await requestSubscription(sql, "new@example.com");
    await sql`update subscriber set confirmed_at = '2026-01-01T00:00:00Z'`;

    await requestSubscription(sql, "NEW@example.com");

    const [row] = await subscribers();
    expect(row!.confirmed_at?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(row!.confirmation_sent_at).toBeNull();
  });

  it.each([
    "",
    "no-at-sign",
    "a@b",
    "@example.com",
    "two@@example.com",
    "has space@example.com",
    `${"a".repeat(250)}@example.com`,
  ])("rejects the invalid address %j", async (email) => {
    await expect(requestSubscription(sql, email)).rejects.toMatchObject({ code: "22023" });
    expect(await subscribers()).toHaveLength(0);
  });

  // Accepted and rejected addresses for migration 8's pattern. The rejected
  // list includes the two junk addresses the old check let through.
  it.each([
    "a@b.co",
    "first.last@example.com",
    "user+tag@sub.example.co.uk",
    "o'brien@example.com",
    "{curly}~tilde@example.com",
    "a-b@x-y.example",
    "UPPER@EXAMPLE.COM",
    `${"a".repeat(64)}@example.com`,
    "1@2.34",
  ])("accepts the valid address %j", async (email) => {
    await requestSubscription(sql, email);
    expect(await subscribers()).toMatchObject([{ email: email.toLowerCase() }]);
  });

  it.each([
    "a@b..c",
    "<x>,y@-.-",
    ".a@example.com",
    "a.@example.com",
    "a..b@example.com",
    "a@-example.com",
    "a@example-.com",
    "a@example.-com",
    "a@example..com",
    "a@.example.com",
    "a@example.com.",
    "a@exa_mple.com",
    "a b@example.com",
    "a,b@example.com",
    "a(b)@example.com",
    "a@b@example.com",
    "a@localhost",
    `${"a".repeat(65)}@example.com`,
  ])("rejects the malformed address %j", async (email) => {
    await expect(requestSubscription(sql, email)).rejects.toMatchObject({ code: "22023" });
    expect(await subscribers()).toHaveLength(0);
  });

  it("rejects a null address", async () => {
    await expect(sql`select request_subscription(${null})`).rejects.toMatchObject({
      code: "22023",
    });
  });

  it("re-queues an unconfirmed address only after a day, and only three times", async () => {
    await requestSubscription(sql, "new@example.com");
    await sql`update subscriber set confirmation_sent_at = now(), confirmation_attempts = 1`;

    // Sent a moment ago: nothing to re-queue.
    await requestSubscription(sql, "new@example.com");
    expect((await subscribers())[0]!.confirmation_sent_at).not.toBeNull();

    // Sent two days ago: queued again.
    await sql`update subscriber set confirmation_sent_at = now() - interval '2 days'`;
    await requestSubscription(sql, "new@example.com");
    expect((await subscribers())[0]!.confirmation_sent_at).toBeNull();

    // Three sends already: the ceiling holds however old the last one is.
    await sql`update subscriber set confirmation_sent_at = now() - interval '2 days', confirmation_attempts = 3`;
    await requestSubscription(sql, "new@example.com");
    expect((await subscribers())[0]!.confirmation_sent_at).not.toBeNull();
  });

  it("puts an unsubscribed address back through double opt-in with a new token", async () => {
    await requestSubscription(sql, "new@example.com");
    await sql`
      update subscriber set confirmed_at = now(), unsubscribed_at = now(),
        confirmation_sent_at = now(), confirmation_attempts = 3
    `;
    const [before] = await subscribers();

    await requestSubscription(sql, "new@example.com");

    const [after] = await subscribers();
    expect(after).toMatchObject({
      confirmed_at: null,
      unsubscribed_at: null,
      confirmation_sent_at: null,
      confirmation_attempts: 0,
    });
    expect(after!.confirm_token).not.toBe(before!.confirm_token);
    expect(await sql`select id from subscription`).toHaveLength(1);
  });
});

describe("sendPendingConfirmations", () => {
  it("mails a link carrying the subscriber's confirm token, exactly once", SLOW_SMTP, async () => {
    await requestSubscription(sql, "new@example.com");
    const [row] = await subscribers();

    expect(await sendConfirmations()).toEqual({ sent: 1, failed: 0, cleaned: 0 });

    const { total, messages } = await inbox();
    expect(total).toBe(1);
    expect(messages[0]!.To[0]!.Address).toBe("new@example.com");

    const { HTML, Text } = await messageBodies(messages[0]!.ID);
    const link = `${PUBLIC_URL}/confirm?token=${row!.confirm_token}`;
    expect(HTML).toContain(link);
    expect(Text).toContain(link);

    expect(await subscribers()).toMatchObject([{ confirmation_attempts: 1 }]);
    expect((await subscribers())[0]!.confirmation_sent_at).not.toBeNull();

    expect(await sendConfirmations()).toEqual({ sent: 0, failed: 0, cleaned: 0 });
    expect((await inbox()).total).toBe(1);
  });

  it(
    "counts a failed send as an attempt, leaves the row pending, and retries it",
    SLOW_SMTP,
    async () => {
      await requestSubscription(sql, "new@example.com");

      const failing = await sendPendingConfirmations(sql, {
        send: createSmtpSender("smtp://localhost:54399"),
        from: FROM,
        publicUrl: PUBLIC_URL,
      });
      expect(failing).toEqual({ sent: 0, failed: 1, cleaned: 0 });
      expect(await subscribers()).toMatchObject([
        { confirmation_sent_at: null, confirmation_attempts: 1 },
      ]);

      expect(await sendConfirmations()).toEqual({ sent: 1, failed: 0, cleaned: 0 });
      expect(await subscribers()).toMatchObject([{ confirmation_attempts: 2 }]);
    },
  );

  it("stops retrying a row after three failed attempts", async () => {
    await requestSubscription(sql, "dead@example.com");

    for (let run = 1; run <= 3; run += 1) {
      expect(await sendWith(rejecting)).toMatchObject({ sent: 0, failed: 1 });
    }

    expect(await subscribers()).toMatchObject([
      { confirmation_sent_at: null, confirmation_attempts: 3 },
    ]);
    expect(await sendWith(rejecting)).toMatchObject({ sent: 0, failed: 0 });
  });

  it("does not let twenty undeliverable rows block a valid later signup", async () => {
    for (let n = 0; n < 20; n += 1) await requestSubscription(sql, `bad${n}@example.com`);
    await requestSubscription(sql, "valid@example.com");
    const delivered: string[] = [];
    const picky: SendEmail = async (message) => {
      if (message.to.startsWith("bad")) throw new Error("550 mailbox unavailable");
      delivered.push(message.to);
    };

    // Run 1 is spent entirely on the oldest twenty, all of which fail.
    expect(await sendWith(picky)).toMatchObject({ sent: 0, failed: 20 });
    // Run 2 puts the never-tried signup ahead of the ones that already failed.
    expect(await sendWith(picky)).toMatchObject({ sent: 1, failed: 19 });
    expect(delivered).toEqual(["valid@example.com"]);

    // The rest drop out after three attempts each: nothing is left to try.
    await sendWith(picky);
    await sendWith(picky);
    expect(await sendWith(picky)).toMatchObject({ sent: 0, failed: 0 });
    const bad = (await subscribers()).filter((row) => row.email.startsWith("bad"));
    expect(bad).toHaveLength(20);
    expect(bad.every((row) => row.confirmation_attempts === 3)).toBe(true);
  });

  it("sends at most `limit` messages per run", SLOW_SMTP, async () => {
    for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
      await requestSubscription(sql, email);
    }

    expect(await sendConfirmations({ limit: 2 })).toEqual({ sent: 2, failed: 0, cleaned: 0 });
    expect((await inbox()).total).toBe(2);
    expect(await sendConfirmations({ limit: 2 })).toEqual({ sent: 1, failed: 0, cleaned: 0 });
  });

  it("does not mail a confirmed or unsubscribed subscriber", SLOW_SMTP, async () => {
    await requestSubscription(sql, "confirmed@example.com");
    await requestSubscription(sql, "gone@example.com");
    await sql`update subscriber set confirmed_at = now() where email = 'confirmed@example.com'`;
    await sql`update subscriber set unsubscribed_at = now() where email = 'gone@example.com'`;

    expect(await sendConfirmations()).toEqual({ sent: 0, failed: 0, cleaned: 0 });
  });

  it("mails a re-subscribed address again, with the rotated token", SLOW_SMTP, async () => {
    await requestSubscription(sql, "back@example.com");
    await sql`update subscriber set confirmed_at = now(), unsubscribed_at = now()`;
    await requestSubscription(sql, "back@example.com");
    const [row] = await subscribers();

    expect(await sendConfirmations()).toEqual({ sent: 1, failed: 0, cleaned: 0 });

    const { messages } = await inbox();
    const { Text } = await messageBodies(messages[0]!.ID);
    expect(Text).toContain(`token=${row!.confirm_token}`);
  });
});

describe("the daily ceiling", () => {
  // Rows that were mailed at a time set by SQL, so the test needs no 200 real
  // sends. They are neither confirmed nor pending: sent_at is set.
  const seedSent = (count: number, age: string) => sql`
    insert into subscriber (email, confirmation_sent_at, confirmation_attempts)
    select 'sent-' || n || '@example.com', now() - ${age}::interval, 1
    from generate_series(1, ${count}) as n
  `;
  const seedPending = (count: number) => sql`
    insert into subscriber (email)
    select 'pending-' || n || '@example.com' from generate_series(1, ${count}) as n
  `;

  it("sends at most 200 minus what went out in the last 24 hours", async () => {
    await seedSent(195, "2 hours");
    await seedPending(10);

    expect(await sendWith(accepting)).toEqual({ sent: 5, failed: 0, cleaned: 0 });
    // The ceiling is now full: nothing more until older sends age out.
    expect(await sendWith(accepting)).toEqual({ sent: 0, failed: 0, cleaned: 0 });
  });

  it("does not count sends older than 24 hours", async () => {
    await seedSent(200, "25 hours");
    await seedPending(3);

    expect(await sendWith(accepting)).toEqual({ sent: 3, failed: 0, cleaned: 0 });
  });

  it("still applies the per-run cap of 20 below the ceiling", async () => {
    await seedPending(25);

    expect(await sendWith(accepting)).toEqual({ sent: 20, failed: 0, cleaned: 0 });
  });
});

describe("cleanup of unconfirmed signups", () => {
  const backdate = (email: string, age = "8 days") => sql`
    update subscriber
    set requested_at = now() - ${age}::interval, created_at = now() - ${age}::interval
    where email = ${email}
  `;
  const emails = async () => (await subscribers()).map((row) => row.email).sort();

  it("deletes week-old signups that never confirmed, with their subscription", async () => {
    await requestSubscription(sql, "stale@example.com");
    await requestSubscription(sql, "fresh@example.com");
    await backdate("stale@example.com");

    expect(await sendWith(accepting)).toMatchObject({ cleaned: 1 });

    expect(await emails()).toEqual(["fresh@example.com"]);
    expect(await sql`select id from subscription`).toHaveLength(1);
  });

  it("keeps confirmed, unsubscribed and operator rows however old", async () => {
    await requestSubscription(sql, "confirmed@example.com");
    await requestSubscription(sql, "gone@example.com");
    await requestSubscription(sql, "unconfirmed-operator@example.com");
    await sql`update subscriber set confirmed_at = now() where email = 'confirmed@example.com'`;
    await sql`
      update subscriber set confirmed_at = now(), unsubscribed_at = now()
      where email = 'gone@example.com'
    `;
    await ensureOperator(sql, "operator@example.com");
    await sql`update subscriber set confirmed_at = null where email = 'operator@example.com'`;
    for (const email of ["confirmed@example.com", "gone@example.com", "operator@example.com"]) {
      await backdate(email);
    }

    expect(await sendWith(accepting)).toMatchObject({ cleaned: 0 });

    expect(await emails()).toEqual([
      "confirmed@example.com",
      "gone@example.com",
      "operator@example.com",
      "unconfirmed-operator@example.com",
    ]);
  });

  it("gives a returning subscriber a fresh week instead of deleting them at once", async () => {
    await requestSubscription(sql, "back@example.com");
    await sql`update subscriber set confirmed_at = now(), unsubscribed_at = now()`;
    await backdate("back@example.com", "1 year");

    await requestSubscription(sql, "back@example.com");

    expect(await sendWith(accepting)).toMatchObject({ cleaned: 0, sent: 1 });
    expect(await emails()).toEqual(["back@example.com"]);
  });

  it("deletes a stale row that owns digests, because digest cascades from subscriber", async () => {
    await requestSubscription(sql, "owner@example.com");
    const [{ id }] = await sql<{ id: string }[]>`select id from subscriber`;
    const [digest] = await sql<{ id: string }[]>`
      insert into digest (subscriber_id, cadence, window_start, window_end)
      values (${id}, 'daily', now() - interval '20 days', now() - interval '19 days')
      returning id
    `;
    await sql`insert into delivery (digest_id, channel, status) values (${digest!.id}, 'email', 'failed')`;
    await backdate("owner@example.com");

    expect(await sendWith(accepting)).toMatchObject({ cleaned: 1 });

    expect(await emails()).toEqual([]);
    expect(await sql`select id from digest`).toHaveLength(0);
    expect(await sql`select id from delivery`).toHaveLength(0);
  });
});
