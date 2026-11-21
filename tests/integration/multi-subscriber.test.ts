// Slice F.10 outer test (§17): one pipeline run serves every confirmed
// subscriber. Real Postgres and real Mailpit; the subscribers sign up and
// confirm through the same functions the reader calls.
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { MAILPIT_API_URL, MAILPIT_SMTP_URL } from "../../scripts/dev-mail.ts";
import { runPipeline } from "../../src/cli/pipeline.ts";
import type { CandidateEvent } from "../../src/core/types.ts";
import { createEmailChannel } from "../../src/delivery/email.ts";
import { createSmtpSender } from "../../src/delivery/smtp.ts";
import { connect } from "../../src/store/db.ts";
import {
  assembleDigest,
  confirmSubscription,
  ensureOperator,
  ensureSource,
  ingestCandidates,
  requestSubscription,
  unsubscribe,
} from "../../src/store/store.ts";

const sql = connect();

const PUBLIC_URL = "https://pulse.example.com";
const OPERATOR = "operator@example.com";

const emailChannel = createEmailChannel({
  from: "Platform Pulse <pulse@localhost>",
  send: createSmtpSender(MAILPIT_SMTP_URL),
  publicUrl: PUBLIC_URL,
});

// Events are ingested at the database's real clock; a now a full window
// ahead lets the daily window close so assembly can cut it.
const LATER = () => new Date(Date.now() + 25 * 60 * 60 * 1000);

const run = () =>
  runPipeline(sql, {
    adapters: [],
    subscriberEmail: OPERATOR,
    channels: [emailChannel],
    now: LATER,
  });

/** A baseline-change scores 0.9; a browser-support event scores 0.4. */
const baselineEvent = (id: string, taxonomy: string[]): CandidateEvent => ({
  type: "baseline-change",
  subject: { kind: "feature", id },
  title: `${id} is now Baseline widely available`,
  before: { baseline: "low" },
  after: { baseline: "high" },
  occurredAt: "2026-05-21",
  taxonomy,
  dedupeKey: `web-features:baseline:${id}:low->high`,
  correlationKey: `baseline:${id}:high`,
  provenance: [
    {
      sourceId: "web-features",
      url: `https://webstatus.dev/features/${id}`,
      title: id,
      observedAt: "2026-06-10T12:00:00.000Z",
    },
  ],
});

const supportEvent = (id: string, taxonomy: string[]): CandidateEvent => ({
  type: "browser-support",
  subject: { kind: "feature", id },
  title: `Safari 7 supports ${id}`,
  before: null,
  after: { browser: "safari", version: "7" },
  occurredAt: null,
  taxonomy,
  dedupeKey: `web-features:support:${id}:safari:7`,
  correlationKey: `support:${id}:safari:7`,
  provenance: [
    {
      sourceId: "web-features",
      url: `https://webstatus.dev/features/${id}`,
      title: id,
      observedAt: "2026-06-10T12:00:00.000Z",
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

const unsubscribeLink = (token: string) => `${PUBLIC_URL}/unsubscribe?token=${token}`;

const digestTitles = async (subscriberId: string): Promise<string[]> => {
  const rows = await sql<{ title: string }[]>`
    select ce.title from digest d
    join digest_item di on di.digest_id = d.id
    join change_event ce on ce.id = di.event_id
    where d.subscriber_id = ${subscriberId}
    order by ce.title
  `;
  return rows.map((row) => row.title);
};

const digestCount = async (subscriberId: string): Promise<number> => {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from digest where subscriber_id = ${subscriberId}
  `;
  return row!.n;
};

interface InboxMessage {
  ID: string;
  To: { Address: string }[];
}

const inbox = async (): Promise<InboxMessage[]> => {
  const response = await fetch(`${MAILPIT_API_URL}/api/v1/messages`);
  return ((await response.json()) as { messages: InboxMessage[] }).messages;
};

const bodyFor = async (address: string): Promise<{ id: string; text: string }[]> => {
  const mine = (await inbox()).filter((message) => message.To[0]!.Address === address);
  return Promise.all(
    mine.map(async (message) => {
      const response = await fetch(`${MAILPIT_API_URL}/api/v1/message/${message.ID}`);
      const body = (await response.json()) as { Text: string };
      return { id: message.ID, text: body.Text };
    }),
  );
};

beforeEach(async () => {
  await sql`truncate change_event, event_source, digest, digest_item, source_state, subscription, subscriber restart identity cascade`;
  await ensureSource(sql, "web-features", "artifact-diff");
  await fetch(`${MAILPIT_API_URL}/api/v1/messages`, { method: "DELETE" });
});

afterAll(async () => {
  await sql.end();
});

// See delivery.test.ts: the first SMTP response from the Dockerized catcher
// can be held ~10s on some machines.
const SLOW_SMTP = { timeout: 40_000 };

describe("one run, many subscribers", () => {
  it("gives each confirmed subscriber their own filtered digest and email", SLOW_SMTP, async () => {
    await ensureOperator(sql, OPERATOR);
    const aliceId = await signUp("alice@example.com");
    const bobId = await signUp("bob@example.com");
    await sql`
        update subscription set taxonomies = ${["css"]}, significance_floor = 0.5
        where subscriber_id = ${aliceId}
      `;
    await sql`
        update subscription set taxonomies = ${["javascript"]}, significance_floor = 0
        where subscriber_id = ${bobId}
      `;
    await ingestCandidates(sql, [
      baselineEvent("lh", ["css"]),
      supportEvent("crisp-edges", ["css"]),
      baselineEvent("temporal", ["javascript"]),
    ]);

    const summary = await run();

    expect(summary.subscriberFailures).toEqual([]);
    expect(summary.digestIds).toHaveLength(3);
    expect(summary.deliveries).toEqual({ sent: 3, failed: 0 });

    const [operatorRow] = await sql<{ id: string }[]>`
        select id from subscriber where email = ${OPERATOR}
      `;
    expect(await digestTitles(operatorRow!.id)).toEqual([
      "Safari 7 supports crisp-edges",
      "lh is now Baseline widely available",
      "temporal is now Baseline widely available",
    ]);
    // Alice's floor of 0.5 drops the 0.4 support event; Bob's taxonomy drops css.
    expect(await digestTitles(aliceId)).toEqual(["lh is now Baseline widely available"]);
    expect(await digestTitles(bobId)).toEqual(["temporal is now Baseline widely available"]);

    const aliceLink = unsubscribeLink(await tokenOf("alice@example.com"));
    const bobLink = unsubscribeLink(await tokenOf("bob@example.com"));
    const alice = await bodyFor("alice@example.com");
    const bob = await bodyFor("bob@example.com");
    expect(alice).toHaveLength(1);
    expect(bob).toHaveLength(1);
    expect(alice[0]!.text).toContain(aliceLink);
    expect(alice[0]!.text).not.toContain(bobLink);
    expect(bob[0]!.text).toContain(bobLink);
    expect(bob[0]!.text).not.toContain(aliceLink);
    expect(await bodyFor(OPERATOR)).toHaveLength(1);
  });

  it("sends nothing to an unconfirmed or unsubscribed subscriber", SLOW_SMTP, async () => {
    await ensureOperator(sql, OPERATOR);
    await requestSubscription(sql, "pending@example.com");
    await signUp("gone@example.com");
    await unsubscribe(sql, await tokenOf("gone@example.com"));
    await ingestCandidates(sql, [baselineEvent("lh", ["css"])]);

    const summary = await run();

    expect(summary.digestIds).toHaveLength(1);
    expect(summary.deliveries).toEqual({ sent: 1, failed: 0 });
    const [counts] = await sql<{ n: number }[]>`
      select count(*)::int as n from digest d join subscriber s on s.id = d.subscriber_id
      where s.email in ('pending@example.com', 'gone@example.com')
    `;
    expect(counts!.n).toBe(0);
    expect(await bodyFor("pending@example.com")).toEqual([]);
    expect(await bodyFor("gone@example.com")).toEqual([]);
  });

  it(
    "does not backfill a new subscriber with events from before they confirmed",
    SLOW_SMTP,
    async () => {
      await ensureOperator(sql, OPERATOR);
      await ingestCandidates(sql, [
        baselineEvent("old-one", ["css"]),
        baselineEvent("old-two", ["css"]),
      ]);
      await sql`
        update change_event set first_observed_at = now() - interval '10 days'
      `;
      const lateId = await signUp("late@example.com");
      await ingestCandidates(sql, [baselineEvent("fresh", ["css"])]);

      const summary = await run();

      expect(summary.subscriberFailures).toEqual([]);
      expect(await digestCount(lateId)).toBe(1);
      expect(await digestTitles(lateId)).toEqual(["fresh is now Baseline widely available"]);
      expect(await bodyFor("late@example.com")).toHaveLength(1);
    },
  );

  it(
    "does not backfill the gap for a subscriber who left and confirms again",
    SLOW_SMTP,
    async () => {
      await ensureOperator(sql, OPERATOR);
      const returningId = await signUp("returning@example.com");
      await ingestCandidates(sql, [baselineEvent("before-leaving", ["css"])]);
      expect(await assembleDigest(sql, returningId, LATER())).not.toBeNull();
      await unsubscribe(sql, await tokenOf("returning@example.com"));
      // Months pass: the old digest ends 60 days ago, and events from the
      // gap span several daily windows.
      await sql`
        update digest set window_start = window_start - interval '60 days',
                          window_end = window_end - interval '60 days'
        where subscriber_id = ${returningId}
      `;
      await ingestCandidates(sql, [
        baselineEvent("gap-one", ["css"]),
        baselineEvent("gap-two", ["css"]),
        baselineEvent("gap-three", ["css"]),
      ]);
      await sql`
        update change_event set first_observed_at = now() - interval '40 days'
        where dedupe_key like '%gap-one%'
      `;
      await sql`
        update change_event set first_observed_at = now() - interval '30 days'
        where dedupe_key like '%gap-two%'
      `;
      await sql`
        update change_event set first_observed_at = now() - interval '20 days'
        where dedupe_key like '%gap-three%'
      `;
      await signUp("returning@example.com");
      await ingestCandidates(sql, [baselineEvent("after-return", ["css"])]);

      const summary = await run();

      expect(summary.subscriberFailures).toEqual([]);
      expect(await digestCount(returningId)).toBe(2);
      expect(await digestTitles(returningId)).toEqual([
        "after-return is now Baseline widely available",
        "before-leaving is now Baseline widely available",
      ]);
      // The pre-departure digest was never delivered, and the returning
      // subscriber is not mailed it months later: only the post-return one.
      const mail = await bodyFor("returning@example.com");
      expect(mail).toHaveLength(1);
      expect(mail[0]!.text).toContain("after-return");
      expect(mail[0]!.text).not.toContain("before-leaving");
      expect(summary.deliveries).toEqual({ sent: 2, failed: 0 });
    },
  );

  it(
    "keeps assembling the operator's digest after they unsubscribe, but mails nothing",
    SLOW_SMTP,
    async () => {
      const operatorId = await ensureOperator(sql, OPERATOR);
      await unsubscribe(sql, await tokenOf(OPERATOR));
      await ingestCandidates(sql, [baselineEvent("lh", ["css"])]);

      const summary = await run();

      expect(summary.digestIds).toHaveLength(1);
      expect(await digestCount(operatorId)).toBe(1);
      expect(summary.deliveries).toEqual({ sent: 0, failed: 0 });
      expect(await bodyFor(OPERATOR)).toEqual([]);
    },
  );

  it("a second run with nothing new sends nothing", SLOW_SMTP, async () => {
    await ensureOperator(sql, OPERATOR);
    await signUp("alice@example.com");
    await ingestCandidates(sql, [baselineEvent("lh", ["css"])]);
    await run();

    const second = await run();

    expect(second.digestIds).toEqual([]);
    expect(second.deliveries).toEqual({ sent: 0, failed: 0 });
    expect(await inbox()).toHaveLength(2);
  });

  it("one subscriber's failed assembly leaves the others delivered", SLOW_SMTP, async () => {
    await ensureOperator(sql, OPERATOR);
    await signUp("alice@example.com");
    const bobId = await signUp("bob@example.com");
    await ingestCandidates(sql, [baselineEvent("lh", ["css"])]);
    // A database fault scoped to Bob: inserting any digest row for him raises.
    await sql.unsafe(`
      create function fail_for_bob() returns trigger language plpgsql as $$
      begin
        if new.subscriber_id = '${bobId}' then raise exception 'injected failure'; end if;
        return new;
      end $$
    `);
    await sql.unsafe(
      "create trigger fail_for_bob before insert on digest for each row execute function fail_for_bob()",
    );
    try {
      const summary = await run();

      expect(summary.subscriberFailures).toEqual([bobId]);
      expect(summary.digestIds).toHaveLength(2);
      expect(summary.deliveries).toEqual({ sent: 2, failed: 0 });
      expect(await bodyFor("alice@example.com")).toHaveLength(1);
      expect(await bodyFor("bob@example.com")).toEqual([]);
      expect(await bodyFor(OPERATOR)).toHaveLength(1);
    } finally {
      await sql.unsafe("drop trigger fail_for_bob on digest");
      await sql.unsafe("drop function fail_for_bob()");
    }
  });
});
