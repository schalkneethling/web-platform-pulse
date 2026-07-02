// Slice 2 outer test (§16): the digest lands in the inbox, idempotently
// re-sendable. The pipeline delivers through the email channel into the
// local Mailpit catcher; a repeated run sends nothing new, and a failed
// delivery is re-sent by the next run.
import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { MAILPIT_API_URL, MAILPIT_SMTP_URL } from "../../scripts/dev-mail.ts";
import { createWebFeaturesAdapter } from "../../src/adapters/web-features.ts";
import { runPipeline } from "../../src/cli/pipeline.ts";
import type { DeliveryChannel } from "../../src/core/delivery.ts";
import type { WebFeaturesData } from "../../src/core/web-features/diff.ts";
import { createEmailChannel } from "../../src/delivery/email.ts";
import { createSmtpSender } from "../../src/delivery/smtp.ts";
import { connect } from "../../src/store/db.ts";

const sql = connect();

const load = (name: string): WebFeaturesData =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/web-features/${name}`, import.meta.url), "utf8"),
  ) as WebFeaturesData;

const FROM = "Platform Pulse <pulse@localhost>";

const emailChannel = createEmailChannel({
  from: FROM,
  send: createSmtpSender(MAILPIT_SMTP_URL),
});

/** Same channel identity, but its SMTP server does not exist. */
const brokenChannel = createEmailChannel({
  from: FROM,
  send: createSmtpSender("smtp://localhost:54399"),
});

const run = (fixture: string, channels: DeliveryChannel[]) =>
  runPipeline(sql, {
    adapters: [
      createWebFeaturesAdapter({
        fetchData: () => Promise.resolve(load(fixture)),
        now: () => new Date("2026-06-10T12:00:00Z"),
      }),
    ],
    subscriberEmail: "operator@example.com",
    channels,
    // A now a full window ahead lets the daily window close for assembly.
    now: () => new Date(Date.now() + 25 * 60 * 60 * 1000),
  });

interface InboxMessage {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

const inbox = async (): Promise<{ total: number; messages: InboxMessage[] }> => {
  const response = await fetch(`${MAILPIT_API_URL}/api/v1/messages`);
  return (await response.json()) as { total: number; messages: InboxMessage[] };
};

const messageHtml = async (id: string): Promise<string> => {
  const response = await fetch(`${MAILPIT_API_URL}/api/v1/message/${id}`);
  return ((await response.json()) as { HTML: string }).HTML;
};

beforeEach(async () => {
  await sql`truncate change_event, event_source, digest, digest_item, source_state, subscription, subscriber restart identity cascade`;
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

describe("email delivery", () => {
  it("the digest lands in the inbox with provenance, exactly once", SLOW_SMTP, async () => {
    await run("old.json", [emailChannel]);
    const second = await run("new.json", [emailChannel]);
    expect(second.deliveries).toEqual({ sent: 1, failed: 0 });

    const { total, messages } = await inbox();
    expect(total).toBe(1);
    expect(messages[0]!.To[0]!.Address).toBe("operator@example.com");

    const html = await messageHtml(messages[0]!.ID);
    expect(html).toMatch(/widely available/i);
    expect(html).toContain("https://webstatus.dev/features/lh");

    const repeat = await run("new.json", [emailChannel]);
    expect(repeat.deliveries).toEqual({ sent: 0, failed: 0 });
    expect((await inbox()).total).toBe(1);
  });

  it("a failed delivery is re-sent by the next run", SLOW_SMTP, async () => {
    await run("old.json", [brokenChannel]);
    const failing = await run("new.json", [brokenChannel]);
    expect(failing.deliveries).toEqual({ sent: 0, failed: 1 });
    expect((await inbox()).total).toBe(0);

    const retry = await run("new.json", [emailChannel]);
    expect(retry.digestIds).toEqual([]);
    expect(retry.deliveries).toEqual({ sent: 1, failed: 0 });
    expect((await inbox()).total).toBe(1);
  });
});
