import { orderForDigest, type DigestView } from "../core/digest.ts";
import { scoreSignificance } from "../core/significance.ts";
import type { CandidateEvent, ChangeEvent, Provenance, Subject } from "../core/types.ts";
import type { Queryable, Sql } from "./db.ts";

export interface IngestResult {
  created: number;
  correlated: number;
  unchanged: number;
}

interface ChangeEventRow {
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

const rowToEvent = (row: ChangeEventRow, provenance: Provenance[]): ChangeEvent => ({
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

/** The single operator of v1: a real subscriber row with a real subscription. */
export const ensureOperator = async (sql: Sql, email: string): Promise<string> => {
  const rows = await sql<{ id: string }[]>`
    insert into subscriber (email) values (${email})
    on conflict (email) do update set email = excluded.email
    returning id
  `;
  const subscriberId = rows[0]!.id;
  await sql`
    insert into subscription (subscriber_id)
    select ${subscriberId}
    where not exists (select 1 from subscription where subscriber_id = ${subscriberId})
  `;
  return subscriberId;
};

const eventsWithProvenance = async (
  sql: Queryable,
  rows: ChangeEventRow[],
): Promise<ChangeEvent[]> => {
  const events: ChangeEvent[] = [];
  for (const row of rows) {
    const provenance = await sql<
      { source_id: string; url: string; title: string; observed_at: Date; raw_ref: string | null }[]
    >`
      select source_id, url, title, observed_at, raw_ref
      from event_source where event_id = ${row.id} order by observed_at, url
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

/**
 * Slice 1 digest assembly (§9, with the §16 "since last run" shortcut):
 * batch every matched event not yet delivered to this subscriber into one
 * digest. Cadence-window batching replaces the shortcut in slice 5.
 */
export const assembleDigest = async (sql: Sql, subscriberId: string): Promise<string | null> => {
  return sql.begin(async (tx) => {
    const pending = await tx<ChangeEventRow[]>`
      select * from change_event
      where id not in (
        select di.event_id from digest_item di
        join digest d on di.digest_id = d.id
        where d.subscriber_id = ${subscriberId}
      )
      order by first_observed_at
    `;
    if (pending.length === 0) return null;

    const subscription = await tx<{ cadence: string }[]>`
      select cadence from subscription where subscriber_id = ${subscriberId} limit 1
    `;
    const cadence = subscription[0]?.cadence ?? "daily";

    const previous = await tx<{ window_end: Date | null }[]>`
      select max(window_end) as window_end from digest where subscriber_id = ${subscriberId}
    `;
    const windowStart = previous[0]?.window_end ?? pending[0]!.first_observed_at;

    const ordered = orderForDigest(await eventsWithProvenance(tx, pending));

    const digest = await tx<{ id: string }[]>`
      insert into digest (subscriber_id, cadence, window_start, window_end)
      values (${subscriberId}, ${cadence}, ${windowStart}, now())
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
  });
};

/** The operator is v1's only subscriber; the reader renders their digest. */
export const findOperator = async (sql: Sql): Promise<string | null> => {
  const rows = await sql<{ id: string }[]>`
    select id from subscriber order by created_at limit 1
  `;
  return rows[0]?.id ?? null;
};

export const getLatestDigest = async (
  sql: Sql,
  subscriberId: string,
): Promise<DigestView | null> => {
  const digests = await sql<
    { id: string; cadence: string; window_start: Date; window_end: Date }[]
  >`
    select id, cadence, window_start, window_end
    from digest where subscriber_id = ${subscriberId}
    order by window_end desc limit 1
  `;
  const digest = digests[0];
  if (!digest) return null;

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
