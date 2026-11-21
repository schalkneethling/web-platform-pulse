// Slice F.9 outer test (§17): the two links in a subscriber's email. Real
// Postgres; the functions under test are the same confirm_subscription and
// unsubscribe the browser calls through PostgREST.
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import type { CandidateEvent } from "../../src/core/types.ts";
import { connect } from "../../src/store/db.ts";
import {
  assembleDigest,
  confirmSubscription,
  digestsAwaitingDelivery,
  ensureSource,
  ingestCandidates,
  requestSubscription,
  unsubscribe,
} from "../../src/store/store.ts";

const sql = connect();

const UNKNOWN_TOKEN = "00000000-0000-4000-8000-000000000000";

interface SubscriberRow {
  id: string;
  confirmed_at: Date | null;
  unsubscribed_at: Date | null;
  confirm_token: string;
  unsubscribe_token: string;
}

const subscriber = async (email: string): Promise<SubscriberRow> => {
  const rows = await sql<SubscriberRow[]>`
    select id, confirmed_at, unsubscribed_at, confirm_token, unsubscribe_token
    from subscriber where email = ${email}
  `;
  return rows[0]!;
};

const candidate = (): CandidateEvent => ({
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
});

beforeEach(async () => {
  await sql`truncate change_event, event_source, digest, digest_item, source_state, subscription, subscriber restart identity cascade`;
});

afterAll(async () => {
  await sql.end();
});

describe("confirm_subscription", () => {
  it("stamps confirmed_at, and a second call returns true without a second write", async () => {
    await requestSubscription(sql, "new@example.com");
    const { confirm_token } = await subscriber("new@example.com");

    expect(await confirmSubscription(sql, confirm_token)).toBe(true);
    const first = (await subscriber("new@example.com")).confirmed_at;
    expect(first).not.toBeNull();

    // now() differs between statements, so a rewrite would change the value.
    expect(await confirmSubscription(sql, confirm_token)).toBe(true);
    expect((await subscriber("new@example.com")).confirmed_at).toEqual(first);
  });

  it("returns false for an unknown token and changes nothing", async () => {
    await requestSubscription(sql, "new@example.com");

    expect(await confirmSubscription(sql, UNKNOWN_TOKEN)).toBe(false);
    expect((await subscriber("new@example.com")).confirmed_at).toBeNull();
  });

  it("rejects a token that is not a uuid", async () => {
    await expect(confirmSubscription(sql, "not-a-uuid")).rejects.toMatchObject({ code: "22P02" });
  });

  it("returns false for the confirm token of an unsubscribed subscriber", async () => {
    await requestSubscription(sql, "new@example.com");
    const { confirm_token, unsubscribe_token } = await subscriber("new@example.com");
    await unsubscribe(sql, unsubscribe_token);

    expect(await confirmSubscription(sql, confirm_token)).toBe(false);
    expect((await subscriber("new@example.com")).confirmed_at).toBeNull();
  });

  it("does not let an old link revive a subscription after a re-subscribe", async () => {
    await requestSubscription(sql, "new@example.com");
    const old = await subscriber("new@example.com");
    await confirmSubscription(sql, old.confirm_token);
    await unsubscribe(sql, old.unsubscribe_token);
    await requestSubscription(sql, "new@example.com");

    expect(await confirmSubscription(sql, old.confirm_token)).toBe(false);
    const fresh = await subscriber("new@example.com");
    expect(fresh.confirmed_at).toBeNull();
    expect(await confirmSubscription(sql, fresh.confirm_token)).toBe(true);
  });

  it("takes a visitor from signup to confirmed", async () => {
    await requestSubscription(sql, "visitor@example.com");
    const pending = await subscriber("visitor@example.com");
    expect(pending.confirmed_at).toBeNull();

    expect(await confirmSubscription(sql, pending.confirm_token)).toBe(true);

    expect(await subscriber("visitor@example.com")).toMatchObject({ unsubscribed_at: null });
    expect((await subscriber("visitor@example.com")).confirmed_at).not.toBeNull();
  });
});

describe("unsubscribe", () => {
  it("stamps unsubscribed_at once and repeats as a no-op", async () => {
    await requestSubscription(sql, "new@example.com");
    const { unsubscribe_token } = await subscriber("new@example.com");

    expect(await unsubscribe(sql, unsubscribe_token)).toBe(true);
    const first = (await subscriber("new@example.com")).unsubscribed_at;
    expect(first).not.toBeNull();

    expect(await unsubscribe(sql, unsubscribe_token)).toBe(true);
    expect((await subscriber("new@example.com")).unsubscribed_at).toEqual(first);
  });

  it("returns false for an unknown token and changes nothing", async () => {
    await requestSubscription(sql, "new@example.com");

    expect(await unsubscribe(sql, UNKNOWN_TOKEN)).toBe(false);
    expect((await subscriber("new@example.com")).unsubscribed_at).toBeNull();
  });

  it("rejects a token that is not a uuid", async () => {
    await expect(unsubscribe(sql, "not-a-uuid")).rejects.toMatchObject({ code: "22P02" });
  });

  it("keeps the unsubscribe token, so an older email still works", async () => {
    await requestSubscription(sql, "new@example.com");
    const before = await subscriber("new@example.com");
    await unsubscribe(sql, before.unsubscribe_token);
    await requestSubscription(sql, "new@example.com");

    expect((await subscriber("new@example.com")).unsubscribe_token).toBe(before.unsubscribe_token);
    expect(await unsubscribe(sql, before.unsubscribe_token)).toBe(true);
    expect((await subscriber("new@example.com")).unsubscribed_at).not.toBeNull();
  });

  it("removes the subscriber's digests from the delivery queue straight away", async () => {
    await ensureSource(sql, "web-features", "artifact-diff");
    await requestSubscription(sql, "new@example.com");
    const { id, confirm_token, unsubscribe_token } = await subscriber("new@example.com");
    await confirmSubscription(sql, confirm_token);
    await ingestCandidates(sql, [candidate()]);
    await assembleDigest(sql, id, new Date(Date.now() + 25 * 60 * 60 * 1000));

    expect(await digestsAwaitingDelivery(sql, "email")).toMatchObject([
      { email: "new@example.com", unsubscribeToken: unsubscribe_token },
    ]);

    await unsubscribe(sql, unsubscribe_token);

    expect(await digestsAwaitingDelivery(sql, "email")).toEqual([]);
  });
});

describe("delivery gate", () => {
  const assembleBeforeLeaving = async () => {
    await ensureSource(sql, "web-features", "artifact-diff");
    await requestSubscription(sql, "back@example.com");
    const first = await subscriber("back@example.com");
    await confirmSubscription(sql, first.confirm_token);
    await ingestCandidates(sql, [candidate()]);
    await assembleDigest(sql, first.id, new Date(Date.now() + 25 * 60 * 60 * 1000));
    await unsubscribe(sql, first.unsubscribe_token);
    // Re-requesting clears unsubscribed_at and confirmed_at (migration 5).
    await requestSubscription(sql, "back@example.com");
    return first;
  };

  it("holds a re-requested subscriber's digest until they confirm again", async () => {
    await assembleBeforeLeaving();

    expect(await digestsAwaitingDelivery(sql, "email")).toEqual([]);
  });

  it("never mails a digest that ended before the subscriber confirmed again", async () => {
    const first = await assembleBeforeLeaving();
    // The digest was cut and never delivered before they left, two days ago.
    await sql`
      update digest set window_start = window_start - interval '2 days',
                        window_end = window_end - interval '2 days'
      where subscriber_id = ${first.id}
    `;

    const again = await subscriber("back@example.com");
    await confirmSubscription(sql, again.confirm_token);

    expect(await digestsAwaitingDelivery(sql, "email")).toEqual([]);
  });

  it("still offers a digest whose window ends after the confirmation", async () => {
    const first = await assembleBeforeLeaving();
    const again = await subscriber("back@example.com");
    await confirmSubscription(sql, again.confirm_token);

    expect(await digestsAwaitingDelivery(sql, "email")).toMatchObject([
      { email: "back@example.com" },
    ]);
    expect(first.id).toBe(again.id);
  });
});
