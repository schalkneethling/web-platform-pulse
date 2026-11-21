import type { DeliveryResult } from "../core/delivery.ts";
import { orderForDigest, type DigestView } from "../core/digest.ts";
import { scoreSignificance } from "../core/significance.ts";
import type { CandidateEvent, ChangeEvent, Provenance, Subject } from "../core/types.ts";
import type { Queryable, Sql } from "./db.ts";

export interface IngestResult {
  created: number;
  correlated: number;
  unchanged: number;
}

export interface ChangeEventRow {
  id: string;
  type: ChangeEvent["type"];
  subject: Subject;
  title: string;
  before: unknown;
  after: unknown;
  occurred_at: string | null;
  first_observed_at: Date;
  last_updated_at: Date;
  significance: number;
  taxonomy: string[];
  dedupe_key: string;
  correlation_key: string;
}

export const rowToEvent = (row: ChangeEventRow, provenance: Provenance[]): ChangeEvent => ({
  id: row.id,
  type: row.type,
  subject: row.subject,
  title: row.title,
  before: row.before,
  after: row.after,
  occurredAt: row.occurred_at,
  firstObservedAt: row.first_observed_at.toISOString(),
  lastUpdatedAt: row.last_updated_at.toISOString(),
  significance: row.significance,
  taxonomy: row.taxonomy,
  dedupeKey: row.dedupe_key,
  correlationKey: row.correlation_key,
  provenance,
});

const attachProvenance = async (
  sql: Queryable,
  eventId: string,
  provenance: Provenance[],
): Promise<number> => {
  let attached = 0;
  for (const p of provenance) {
    const inserted = await sql`
      insert into event_source (event_id, source_id, url, title, observed_at, raw_ref)
      values (${eventId}, ${p.sourceId}, ${p.url}, ${p.title}, ${p.observedAt}, ${p.rawRef ?? null})
      on conflict (event_id, source_id, url) do nothing
      returning id
    `;
    attached += inserted.length;
  }
  return attached;
};

/**
 * Correlation and de-duplication (§7): one real-world change is one
 * change_event row. A candidate whose correlation key matches an existing
 * event attaches its provenance to that event; otherwise it creates one.
 * Re-running with the same upstream state writes nothing new.
 */
export const ingestCandidates = async (
  sql: Sql,
  candidates: CandidateEvent[],
): Promise<IngestResult> => {
  const result: IngestResult = { created: 0, correlated: 0, unchanged: 0 };

  for (const candidate of candidates) {
    await sql.begin(async (tx) => {
      const existing = await tx<{ id: string }[]>`
        select id from change_event where correlation_key = ${candidate.correlationKey}
      `;

      if (existing.length > 0) {
        const eventId = existing[0]!.id;
        const attached = await attachProvenance(tx, eventId, candidate.provenance);
        if (attached > 0) {
          await tx`update change_event set last_updated_at = now() where id = ${eventId}`;
          result.correlated += 1;
        } else {
          result.unchanged += 1;
        }
        return;
      }

      const created = await tx<{ id: string }[]>`
        insert into change_event
          (type, subject, title, before, after, occurred_at, significance, taxonomy, dedupe_key, correlation_key)
        values
          (${candidate.type}, ${tx.json(candidate.subject)}, ${candidate.title},
           ${candidate.before === null ? null : tx.json(candidate.before as never)},
           ${tx.json(candidate.after as never)}, ${candidate.occurredAt},
           ${scoreSignificance(candidate)}, ${candidate.taxonomy},
           ${candidate.dedupeKey}, ${candidate.correlationKey})
        on conflict (dedupe_key) do nothing
        returning id
      `;

      if (created.length === 0) {
        result.unchanged += 1;
        return;
      }
      await attachProvenance(tx, created[0]!.id, candidate.provenance);
      result.created += 1;
    });
  }

  return result;
};

export const ensureSource = async (sql: Sql, id: string, kind: string): Promise<void> => {
  await sql`insert into source (id, kind) values (${id}, ${kind}) on conflict (id) do nothing`;
};

export const loadSourceState = async <T>(sql: Sql, sourceId: string): Promise<T | null> => {
  const rows = await sql<{ state: T }[]>`
    select state from source_state where source_id = ${sourceId}
  `;
  return rows[0]?.state ?? null;
};

export const saveSourceState = async (
  sql: Sql,
  sourceId: string,
  state: unknown,
): Promise<void> => {
  await sql`
    insert into source_state (source_id, state, updated_at)
    values (${sourceId}, ${sql.json(state as never)}, now())
    on conflict (source_id) do update set state = excluded.state, updated_at = now()
  `;
};

/**
 * Establishes the operator: exactly one subscriber is the operator, identified
 * by `is_operator` (migration 7), not by being the first row. The public
 * reader shows only that subscriber's digest.
 *
 * It sets the flag on every run, so a database that predates the column heals
 * itself. If another row holds the flag (the configured address changed), the
 * flag moves in the same transaction: cleared there first, because the
 * partial unique index allows only one true row at any moment. The old
 * operator stays an ordinary subscriber. The address matches case-insensitively,
 * like migration 5's `lower(email)` index, so a case variant is the same row.
 *
 * The operator is always confirmed: it is seeded from a trusted env var, not
 * the public signup form, so it skips the double opt-in other subscribers go
 * through (§17). It never clears `unsubscribed_at`.
 *
 * The browser identity (`auth_user_id`, migration 10) does not move with the
 * flag. The row that loses the flag loses its link, and a row that gains the
 * flag starts without one, so after a change of address nobody can curate from
 * the browser until `operator link` is run for the new operator. A row that
 * already is the operator keeps its link.
 */
export const ensureOperator = async (sql: Sql, email: string): Promise<string> =>
  (await sql.begin(async (tx) => {
    // The link to the auth user (migration 10) belongs to the person who made
    // it, so it is cleared with the flag. Otherwise moving the flag would leave
    // the previous operator's Google account curating for the new one.
    await tx`
      update subscriber set is_operator = false, auth_user_id = null
      where is_operator and lower(email) <> lower(${email})
    `;
    // A row that already is the operator keeps its link. One that is becoming
    // the operator starts unlinked whatever it held before, so nobody is the
    // browser operator until `operator link` says who.
    const rows = await tx<{ id: string }[]>`
      insert into subscriber (email, confirmed_at, is_operator) values (${email}, now(), true)
      on conflict (lower(email)) do update
        set is_operator = true,
            confirmed_at = coalesce(subscriber.confirmed_at, now()),
            auth_user_id = case when subscriber.is_operator then subscriber.auth_user_id end
      returning id
    `;
    const subscriberId = rows[0]!.id;
    await tx`
      insert into subscription (subscriber_id)
      select ${subscriberId}
      where not exists (select 1 from subscription where subscriber_id = ${subscriberId})
    `;
    return subscriberId;
  })) as string;

/**
 * Records which Supabase Auth user is the operator, so that
 * `is_operator_request()` (migration 10) recognises that user's token. The row
 * is found by the operator's address, so a command run against the wrong
 * database or with the wrong address links nothing instead of linking someone
 * else. Returns false when no operator has that address.
 */
export const linkOperator = async (
  sql: Sql,
  email: string,
  authUserId: string,
): Promise<boolean> => {
  const rows = await sql<{ id: string }[]>`
    update subscriber set auth_user_id = ${authUserId}::uuid
    where is_operator and lower(email) = lower(${email})
    returning id
  `;
  return rows.length > 0;
};

/** Removes the operator's link; nobody can curate from the browser until it is set again. */
export const unlinkOperator = async (
  sql: Sql,
  email: string,
): Promise<"unlinked" | "not-linked" | "no-operator"> => {
  const rows = await sql<{ previous: string | null }[]>`
    with target as (
      select id, auth_user_id from subscriber
      where is_operator and lower(email) = lower(${email}) for update
    )
    update subscriber s set auth_user_id = null
    from target where s.id = target.id
    returning target.auth_user_id as previous
  `;
  if (rows.length === 0) return "no-operator";
  return rows[0]!.previous === null ? "not-linked" : "unlinked";
};

/**
 * Subscribers a pipeline run assembles digests for: the confirmed, not
 * unsubscribed ones, plus the operator whatever their state. The operator's
 * digest is the public edition the reader shows (migration 7), so it must be
 * assembled even after the operator presses the unsubscribe link in their own
 * email; that link only stops the operator's email, which
 * `digestsAwaitingDelivery` gates separately. Oldest first, with the id as a
 * tie-break, so the operator (created first) goes first and the order is the
 * same on every run.
 */
export const activeSubscriberIds = async (sql: Queryable): Promise<string[]> => {
  const rows = await sql<{ id: string }[]>`
    select id from subscriber
    where (confirmed_at is not null and unsubscribed_at is null) or is_operator
    order by created_at, id
  `;
  return rows.map((row) => row.id);
};

/**
 * The public signup write path (§17). Calls the same `request_subscription`
 * function the browser reaches through PostgREST, so the Node tests and the
 * reader exercise one implementation. It queues a confirmation for a new or
 * returning address and does nothing for a confirmed one; the result never
 * says which (see migration 5).
 */
export const requestSubscription = async (sql: Queryable, email: string): Promise<void> => {
  await sql`select request_subscription(${email})`;
};

/**
 * The confirm link's action (migration 6). True when the token belongs to a
 * subscriber who is now confirmed, whether this call confirmed them or an
 * earlier one did; false for an unknown token or one whose owner has
 * unsubscribed.
 */
export const confirmSubscription = async (sql: Queryable, token: string): Promise<boolean> => {
  const rows = await sql<{ confirm_subscription: boolean }[]>`
    select confirm_subscription(${token}::uuid)
  `;
  return rows[0]!.confirm_subscription;
};

/**
 * The unsubscribe link's action (migration 6). True when the token belongs to
 * a subscriber who is now unsubscribed, including one who already was; false
 * for an unknown token.
 */
export const unsubscribe = async (sql: Queryable, token: string): Promise<boolean> => {
  const rows = await sql<{ unsubscribe: boolean }[]>`select unsubscribe(${token}::uuid)`;
  return rows[0]!.unsubscribe;
};

export interface PendingConfirmation {
  subscriberId: string;
  email: string;
  confirmToken: string;
}

/**
 * How many times a confirmation email is tried before the row is left alone.
 * It matches the ceiling in migration 5 (`confirmation_attempts < 3`) and
 * counts successful and failed sends alike, so an address the mail server
 * rejects costs three attempts in total and then stops taking a place in the
 * queue.
 */
export const MAX_CONFIRMATION_ATTEMPTS = 3;

/**
 * Subscribers owed a confirmation email: not yet confirmed, not unsubscribed,
 * nothing sent since they were queued, and fewer than three attempts so far.
 * Never-tried signups go ahead of ones that already failed, then oldest
 * first, so a run of undeliverable addresses cannot starve the valid ones
 * queued behind them.
 */
export const confirmationsAwaitingSend = async (
  sql: Sql,
  limit: number,
): Promise<PendingConfirmation[]> => {
  const rows = await sql<{ id: string; email: string; confirm_token: string }[]>`
    select id, email, confirm_token from subscriber
    where confirmed_at is null and unsubscribed_at is null and confirmation_sent_at is null
      and confirmation_attempts < ${MAX_CONFIRMATION_ATTEMPTS}
    order by confirmation_attempts, created_at, id
    limit ${limit}
  `;
  return rows.map((row) => ({
    subscriberId: row.id,
    email: row.email,
    confirmToken: row.confirm_token,
  }));
};

/** Mark a confirmation as sent; the attempt count feeds migration 5's resend ceiling. */
export const recordConfirmationSent = async (sql: Sql, subscriberId: string): Promise<void> => {
  await sql`
    update subscriber
    set confirmation_sent_at = now(), confirmation_attempts = confirmation_attempts + 1
    where id = ${subscriberId}
  `;
};

/**
 * Record a failed confirmation send. The row stays pending (no
 * `confirmation_sent_at`), so a brief outage costs one of the three attempts
 * and the next run retries it.
 */
export const recordConfirmationFailed = async (sql: Sql, subscriberId: string): Promise<void> => {
  await sql`
    update subscriber set confirmation_attempts = confirmation_attempts + 1
    where id = ${subscriberId}
  `;
};

/** Confirmation emails sent in the last 24 hours, for the daily ceiling. */
export const confirmationsSentInLastDay = async (sql: Sql): Promise<number> => {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from subscriber
    where confirmation_sent_at > now() - interval '24 hours'
  `;
  return rows[0]!.n;
};

/** How long an unconfirmed signup is kept before the cleanup removes it. */
export const UNCONFIRMED_RETENTION_DAYS = 7;

/**
 * Delete signups that never confirmed: not confirmed, not unsubscribed, not
 * the operator, and requested more than seven days ago (`requested_at`, from
 * migration 8, so a returning subscriber who asks again gets a fresh week).
 * Returns how many rows were removed. Without it, anyone could grow the table
 * without limit through the public form.
 *
 * `subscription`, `digest` (migration 1: `on delete cascade` from subscriber)
 * and their `digest_item` and `delivery` rows go with the subscriber, so the
 * delete cannot fail on a row that owns digests. A returning subscriber who
 * never re-confirmed loses those old digests, which they could no longer
 * receive anyway.
 */
export const deleteStaleUnconfirmed = async (sql: Sql): Promise<number> => {
  const deleted = await sql`
    delete from subscriber
    where confirmed_at is null and unsubscribed_at is null and not is_operator
      and requested_at < now() - make_interval(days => ${UNCONFIRMED_RETENTION_DAYS})
    returning id
  `;
  return deleted.length;
};

export const eventsWithProvenance = async (
  sql: Queryable,
  rows: ChangeEventRow[],
): Promise<ChangeEvent[]> => {
  const events: ChangeEvent[] = [];
  for (const row of rows) {
    const provenance = await sql<
      { source_id: string; url: string; title: string; observed_at: Date; raw_ref: string | null }[]
    >`
      select source_id, url, title, observed_at, raw_ref
      from event_source where event_id = ${row.id}
      order by observed_at, url collate "C"
    `;
    events.push(
      rowToEvent(
        row,
        provenance.map((p) => ({
          sourceId: p.source_id,
          url: p.url,
          title: p.title,
          observedAt: p.observed_at.toISOString(),
          ...(p.raw_ref === null ? {} : { rawRef: p.raw_ref }),
        })),
      ),
    );
  }
  return events;
};

/** Cadence windows (§9): how long each digest window spans. */
export const CADENCE_PERIOD_MS: Record<string, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Digest assembly (§9): cut the next elapsed cadence window that holds
 * matched events. Windows chain from the previous digest's window_end
 * (or the first matched event); an open window is never cut early, and
 * elapsed windows with nothing matched are skipped without a digest.
 * An event matches when it clears the subscription's significance floor
 * and, if the subscription names taxonomies, shares one. Callers loop
 * until null to catch up across multiple elapsed windows.
 *
 * A subscriber's first window starts no earlier than their `confirmed_at`.
 * Without that, someone who confirms today against months of stored events
 * would get one digest per elapsed day of history, all in one run. Later
 * windows chain from the previous digest's window_end. The bound also applies
 * when that window_end is earlier than `confirmed_at`: the subscriber left and
 * confirmed again, and chaining across the gap would flood them with its
 * history. Continuous subscribers have a `confirmed_at` older than their last
 * window_end, so nothing changes for them.
 */
export const assembleDigest = async (
  sql: Sql,
  subscriberId: string,
  now: Date = new Date(),
): Promise<string | null> => {
  return sql.begin(async (tx) => {
    const subscription = await tx<
      { cadence: string; taxonomies: string[] | null; significance_floor: number }[]
    >`
      select cadence, taxonomies, significance_floor
      from subscription where subscriber_id = ${subscriberId} limit 1
    `;
    const confirmation = await tx<{ confirmed_at: Date | null }[]>`
      select confirmed_at from subscriber where id = ${subscriberId}
    `;
    const confirmedAt = confirmation[0]?.confirmed_at ?? null;
    // An unconfirmed subscriber has no first window to open.
    if (confirmedAt === null) return null;
    const cadence = subscription[0]?.cadence ?? "daily";
    const taxonomies = subscription[0]?.taxonomies ?? [];
    const floor = subscription[0]?.significance_floor ?? 0;
    const period = CADENCE_PERIOD_MS[cadence] ?? CADENCE_PERIOD_MS["daily"]!;

    const matches = () => tx`
      significance >= ${floor}
      and (cardinality(${taxonomies}::text[]) = 0 or taxonomy && ${taxonomies}::text[])
      and id not in (
        select di.event_id from digest_item di
        join digest d on di.digest_id = d.id
        where d.subscriber_id = ${subscriberId}
      )
    `;

    const previous = await tx<{ window_end: Date | null }[]>`
      select max(window_end) as window_end from digest where subscriber_id = ${subscriberId}
    `;
    let windowStart: Date | null = previous[0]?.window_end ?? null;
    // A previous digest that ends before the current confirmation belongs to
    // an earlier subscription (they left and confirmed again), so start afresh.
    if (windowStart !== null && windowStart.getTime() < confirmedAt.getTime()) windowStart = null;
    if (windowStart === null) {
      const earliest = await tx<{ first_observed_at: Date }[]>`
        select first_observed_at from change_event
        where ${matches()} and first_observed_at >= ${confirmedAt}
        order by first_observed_at limit 1
      `;
      windowStart = earliest[0]?.first_observed_at ?? null;
      if (windowStart === null) return null;
    }

    for (;;) {
      const windowEnd: Date = new Date(windowStart.getTime() + period);
      if (windowEnd.getTime() > now.getTime()) return null;

      const pending = await tx<ChangeEventRow[]>`
        select * from change_event
        where ${matches()}
          and first_observed_at >= ${windowStart} and first_observed_at < ${windowEnd}
        order by first_observed_at
      `;
      if (pending.length === 0) {
        windowStart = windowEnd;
        continue;
      }

      const ordered = orderForDigest(await eventsWithProvenance(tx, pending));

      const digest = await tx<{ id: string }[]>`
        insert into digest (subscriber_id, cadence, window_start, window_end)
        values (${subscriberId}, ${cadence}, ${windowStart}, ${windowEnd})
        returning id
      `;
      const digestId = digest[0]!.id;
      for (const [position, event] of ordered.entries()) {
        await tx`
          insert into digest_item (digest_id, event_id, position)
          values (${digestId}, ${event.id}, ${position})
        `;
      }
      return digestId;
    }
  });
};

interface DigestRow {
  id: string;
  cadence: string;
  window_start: Date;
  window_end: Date;
}

const digestView = async (sql: Queryable, digest: DigestRow): Promise<DigestView> => {
  const rows = await sql<ChangeEventRow[]>`
    select ce.* from digest_item di
    join change_event ce on ce.id = di.event_id
    where di.digest_id = ${digest.id}
    order by di.position
  `;
  return {
    id: digest.id,
    cadence: digest.cadence,
    windowStart: digest.window_start.toISOString(),
    windowEnd: digest.window_end.toISOString(),
    items: await eventsWithProvenance(sql, rows),
  };
};

export const getLatestDigest = async (
  sql: Sql,
  subscriberId: string,
): Promise<DigestView | null> => {
  const digests = await sql<DigestRow[]>`
    select id, cadence, window_start, window_end
    from digest where subscriber_id = ${subscriberId}
    order by window_end desc limit 1
  `;
  return digests[0] ? digestView(sql, digests[0]) : null;
};

export const getDigest = async (sql: Sql, digestId: string): Promise<DigestView | null> => {
  const digests = await sql<DigestRow[]>`
    select id, cadence, window_start, window_end from digest where id = ${digestId}
  `;
  return digests[0] ? digestView(sql, digests[0]) : null;
};

export interface PendingDelivery {
  digestId: string;
  email: string;
  unsubscribeToken: string;
}

/**
 * How many failed delivery rows a digest may collect on one channel before it
 * is no longer retried. The trade-off: a multi-day outage can now drop a
 * digest for good (five daily runs fail, and the digest is never resent).
 * Unlimited retries meant one dead address failed the daily run every day
 * until someone intervened, which hid real problems behind a permanently red
 * run. Five tries rides out an outage of a few days.
 */
export const MAX_FAILED_DELIVERIES = 5;

/**
 * Digests a channel has not yet successfully delivered (§10). Failed
 * attempts leave the digest pending, so the next run resends only those,
 * until it has failed `MAX_FAILED_DELIVERIES` times. A digest whose window
 * ended before the subscriber's current confirmation is never delivered: it
 * belongs to an earlier subscription, and mailing it months later after they
 * confirm again would be stale news.
 */
export const digestsAwaitingDelivery = async (
  sql: Sql,
  channelId: string,
): Promise<PendingDelivery[]> => {
  const rows = await sql<{ digest_id: string; email: string; unsubscribe_token: string }[]>`
    select d.id as digest_id, s.email, s.unsubscribe_token
    from digest d
    join subscriber s on s.id = d.subscriber_id
    where s.unsubscribed_at is null
      and s.confirmed_at is not null
      and d.window_end > s.confirmed_at
      and not exists (
        select 1 from delivery dv
        where dv.digest_id = d.id and dv.channel = ${channelId} and dv.status = 'sent'
      )
      and (
        select count(*) from delivery dv
        where dv.digest_id = d.id and dv.channel = ${channelId} and dv.status = 'failed'
      ) < ${MAX_FAILED_DELIVERIES}
    order by d.window_end
  `;
  return rows.map((row) => ({
    digestId: row.digest_id,
    email: row.email,
    unsubscribeToken: row.unsubscribe_token,
  }));
};

/** One delivery row per attempt per channel, carrying status (§10). */
export const recordDelivery = async (
  sql: Sql,
  digestId: string,
  channelId: string,
  result: DeliveryResult,
): Promise<void> => {
  await sql`
    insert into delivery (digest_id, channel, status, error)
    values (${digestId}, ${channelId}, ${result.status},
            ${result.status === "failed" ? result.error : null})
  `;
};
