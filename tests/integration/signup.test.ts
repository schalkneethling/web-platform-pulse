// Slice F.8 outer test (§17): a visitor's email becomes an unconfirmed
// subscriber, and the pipeline mails them a confirmation link keyed on their
// confirm_token. Real Postgres and real Mailpit; the write path under test is
// the same request_subscription function the browser calls through PostgREST.
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { MAILPIT_API_URL, MAILPIT_SMTP_URL } from "../../scripts/dev-mail.ts";
import { sendPendingConfirmations } from "../../src/cli/confirmations.ts";
import { createSmtpSender } from "../../src/delivery/smtp.ts";
import { connect } from "../../src/store/db.ts";
import { requestSubscription } from "../../src/store/store.ts";

const sql = connect();

const FROM = "Platform Pulse <pulse@localhost>";
const PUBLIC_URL = "https://pulse.example.com";

const send = createSmtpSender(MAILPIT_SMTP_URL);
const sendConfirmations = (overrides: { limit?: number } = {}) =>
  sendPendingConfirmations(sql, { send, from: FROM, publicUrl: PUBLIC_URL, ...overrides });

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

    expect(await sendConfirmations()).toEqual({ sent: 1, failed: 0 });

    const { total, messages } = await inbox();
    expect(total).toBe(1);
    expect(messages[0]!.To[0]!.Address).toBe("new@example.com");

    const { HTML, Text } = await messageBodies(messages[0]!.ID);
    const link = `${PUBLIC_URL}/confirm?token=${row!.confirm_token}`;
    expect(HTML).toContain(link);
    expect(Text).toContain(link);

    expect(await subscribers()).toMatchObject([{ confirmation_attempts: 1 }]);
    expect((await subscribers())[0]!.confirmation_sent_at).not.toBeNull();

    expect(await sendConfirmations()).toEqual({ sent: 0, failed: 0 });
    expect((await inbox()).total).toBe(1);
  });

  it("leaves a failed send pending so the next run retries it", SLOW_SMTP, async () => {
    await requestSubscription(sql, "new@example.com");

    const failing = await sendPendingConfirmations(sql, {
      send: createSmtpSender("smtp://localhost:54399"),
      from: FROM,
      publicUrl: PUBLIC_URL,
    });
    expect(failing).toEqual({ sent: 0, failed: 1 });
    expect(await subscribers()).toMatchObject([
      { confirmation_sent_at: null, confirmation_attempts: 0 },
    ]);

    expect(await sendConfirmations()).toEqual({ sent: 1, failed: 0 });
  });

  it("sends at most `limit` messages per run", SLOW_SMTP, async () => {
    for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
      await requestSubscription(sql, email);
    }

    expect(await sendConfirmations({ limit: 2 })).toEqual({ sent: 2, failed: 0 });
    expect((await inbox()).total).toBe(2);
    expect(await sendConfirmations({ limit: 2 })).toEqual({ sent: 1, failed: 0 });
  });

  it("does not mail a confirmed or unsubscribed subscriber", SLOW_SMTP, async () => {
    await requestSubscription(sql, "confirmed@example.com");
    await requestSubscription(sql, "gone@example.com");
    await sql`update subscriber set confirmed_at = now() where email = 'confirmed@example.com'`;
    await sql`update subscriber set unsubscribed_at = now() where email = 'gone@example.com'`;

    expect(await sendConfirmations()).toEqual({ sent: 0, failed: 0 });
  });

  it("mails a re-subscribed address again, with the rotated token", SLOW_SMTP, async () => {
    await requestSubscription(sql, "back@example.com");
    await sql`update subscriber set confirmed_at = now(), unsubscribed_at = now()`;
    await requestSubscription(sql, "back@example.com");
    const [row] = await subscribers();

    expect(await sendConfirmations()).toEqual({ sent: 1, failed: 0 });

    const { messages } = await inbox();
    const { Text } = await messageBodies(messages[0]!.ID);
    expect(Text).toContain(`token=${row!.confirm_token}`);
  });
});
