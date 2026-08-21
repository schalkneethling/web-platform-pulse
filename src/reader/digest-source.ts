// Slice F.3 (§6): the reader's read seam, now PostgREST instead of a Vite
// dev-server middleware. This is the browser half of what store.ts does on
// the server -- one nested select standing in for getLatestDigest's query
// plus its per-event provenance follow-up.
//
// The anon role cannot read `subscriber` (see migration 4), so the reader
// cannot resolve an operator the way the server seam did -- it asks for the
// most recent digest of any subscriber. While the deployment is
// single-tenant that is the operator's digest by construction. It stops
// being true the moment a second subscriber exists, which is why
// per-subscriber identity has to land before the reader is shared (#65).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DigestView } from "../core/digest.ts";
import type { ChangeEvent, ChangeEventType, Provenance, Subject } from "../core/types.ts";

/** The nested row PostgREST returns for the query below. */
export interface DigestRow {
  id: string;
  cadence: string;
  window_start: string;
  window_end: string;
  digest_item: DigestItemRow[];
}

interface DigestItemRow {
  position: number;
  change_event: ChangeEventRow | null;
}

interface ChangeEventRow {
  id: string;
  type: string;
  subject: Subject;
  title: string;
  before: unknown;
  after: unknown;
  occurred_at: string | null;
  first_observed_at: string;
  last_updated_at: string;
  significance: number;
  taxonomy: string[];
  dedupe_key: string;
  correlation_key: string;
  event_source: EventSourceRow[];
}

interface EventSourceRow {
  source_id: string;
  url: string;
  title: string;
  observed_at: string;
  raw_ref: string | null;
}

/** The columns and embeds that make up one digest, in one round trip. */
const DIGEST_SELECT = `
  id, cadence, window_start, window_end,
  digest_item (
    position,
    change_event (
      id, type, subject, title, before, after, occurred_at,
      first_observed_at, last_updated_at, significance, taxonomy,
      dedupe_key, correlation_key,
      event_source ( source_id, url, title, observed_at, raw_ref )
    )
  )
`;

/** Postgres hands back `+00:00` offsets; the server seam hands back `Z`.
 * Normalise so a DigestView means the same thing whichever produced it. */
const iso = (value: string): string => new Date(value).toISOString();

/** Must match `order by observed_at, url collate "C"` in store.ts, so the
 * email and the reader list an event's sources identically.
 *
 * Neither half of this can use localeCompare. It orders by the *browser's*
 * locale, so two visitors could see different orders, and none of those
 * orders is the database's. Timestamps are compared as instants rather than
 * strings because PostgREST renders an offset, and "+02:00" sorts after
 * "+00:00" as text while being earlier in time. */
const byObservedAtThenUrl = (a: EventSourceRow, b: EventSourceRow): number => {
  const byTime = Date.parse(a.observed_at) - Date.parse(b.observed_at);
  if (byTime !== 0) return byTime;
  if (a.url === b.url) return 0;
  return a.url < b.url ? -1 : 1;
};

const toProvenance = (row: EventSourceRow): Provenance => ({
  sourceId: row.source_id,
  url: row.url,
  title: row.title,
  observedAt: iso(row.observed_at),
  ...(row.raw_ref === null ? {} : { rawRef: row.raw_ref }),
});

const toEvent = (row: ChangeEventRow): ChangeEvent => ({
  id: row.id,
  type: row.type as ChangeEventType,
  subject: row.subject,
  title: row.title,
  before: row.before,
  after: row.after,
  occurredAt: row.occurred_at,
  firstObservedAt: iso(row.first_observed_at),
  lastUpdatedAt: iso(row.last_updated_at),
  significance: row.significance,
  taxonomy: row.taxonomy,
  dedupeKey: row.dedupe_key,
  correlationKey: row.correlation_key,
  provenance: [...row.event_source].sort(byObservedAtThenUrl).map(toProvenance),
});

/** Shape one PostgREST row like the server's digestView does.
 *
 * Ordering is applied here rather than in the query, so it has to match
 * store.ts explicitly: items by digest_item.position, provenance by
 * (observed_at, url) under C collation.
 *
 * The null-embed guard is defensive rather than reachable: today's policies
 * let anon read every change_event a digest_item points at, so the embed is
 * never null. It would start being null the moment a policy gains a
 * predicate (#65), and a hole in the list is a poor way to find that out. */
export const toDigestView = (row: DigestRow): DigestView => ({
  id: row.id,
  cadence: row.cadence,
  windowStart: iso(row.window_start),
  windowEnd: iso(row.window_end),
  items: [...row.digest_item]
    .sort((a, b) => a.position - b.position)
    .flatMap((item) => (item.change_event ? [toEvent(item.change_event)] : [])),
});

/** The most recent digest, or null when the pipeline has not cut one yet. */
export const fetchLatestDigest = async (client: SupabaseClient): Promise<DigestView | null> => {
  const { data, error } = await client
    .from("digest")
    .select(DIGEST_SELECT)
    .order("window_end", { ascending: false })
    .limit(1)
    .maybeSingle<DigestRow>();

  if (error) throw new Error(error.message);
  return data ? toDigestView(data) : null;
};
