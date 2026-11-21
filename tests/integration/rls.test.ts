// Slice F.2 (§6): the anon role sees the digest and nothing else.
//
// These run against the real policies rather than a REST layer: `set local
// role anon` inside a transaction puts the session on the same footing as
// PostgREST's anon request, which is what the browser bundle will be.
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import type { CandidateEvent } from "../../src/core/types.ts";
import { type Queryable, connect } from "../../src/store/db.ts";
import {
  assembleDigest,
  ensureOperator,
  ensureSource,
  ingestCandidates,
} from "../../src/store/store.ts";

const sql = connect();

/** One day on, so the daily window has elapsed and a digest can be cut. */
const TOMORROW = new Date(Date.now() + 25 * 60 * 60 * 1000);

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

/** Run one query with the session role dropped to anon, as PostgREST does. */
const asAnon = async <T>(query: (tx: Queryable) => Promise<T>): Promise<T> =>
  (await sql.begin(async (tx) => {
    await tx.unsafe("set local role anon");
    return await query(tx);
  })) as T;

beforeEach(async () => {
  await sql`truncate change_event, event_source, digest, digest_item, source_state, subscription, subscriber restart identity cascade`;
  await ensureSource(sql, "web-features", "artifact-diff");
  const subscriberId = await ensureOperator(sql, "operator@example.com");
  await ingestCandidates(sql, [candidate()]);
  await assembleDigest(sql, subscriberId, TOMORROW);
});

afterAll(async () => {
  await sql.end();
});

describe("anon reads", () => {
  it("sees the digest and the events it points at", async () => {
    const digests = await asAnon((tx) => tx`select id from digest`);
    expect(digests).toHaveLength(1);

    const items = await asAnon((tx) => tx`select event_id, position from digest_item`);
    expect(items).toHaveLength(1);

    const events = await asAnon((tx) => tx`select title from change_event`);
    expect(events).toMatchObject([{ title: "lh unit is now Baseline widely available" }]);

    const provenance = await asAnon((tx) => tx`select url from event_source`);
    expect(provenance).toMatchObject([{ url: "https://webstatus.dev/features/lh" }]);
  });
});

describe("anon is denied", () => {
  // The whole point of the slice: the anon key is public, so a subscriber's
  // address and their confirm/unsubscribe tokens must be unreachable.
  it.each(["subscriber", "subscription", "delivery", "source", "source_state"])(
    "cannot read %s",
    async (table) => {
      await expect(asAnon((tx) => tx.unsafe(`select * from ${table}`))).rejects.toThrow(
        /permission denied/i,
      );
    },
  );

  it("cannot write to a table it can read", async () => {
    await expect(
      asAnon((tx) => tx.unsafe("update change_event set title = 'tampered'")),
    ).rejects.toThrow(/permission denied/i);

    await expect(asAnon((tx) => tx.unsafe("delete from digest"))).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe("the policy layer itself", () => {
  // Locally `anon` was never granted anything, so the denials above would
  // pass with RLS switched off entirely. Supabase hands anon table grants by
  // default, where the policies are the only gate -- so assert them directly
  // rather than inferring them from a denial this database can fake.
  it("has row level security enabled on every table", async () => {
    const tables = await sql<{ relname: string; relrowsecurity: boolean }[]>`
      select c.relname, c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname <> '_migration'
      order by c.relname
    `;
    expect(tables.map((t) => t.relname)).toEqual([
      "change_event",
      "delivery",
      "digest",
      "digest_item",
      "event_source",
      "source",
      "source_state",
      "subscriber",
      "subscription",
    ]);
    expect(tables.filter((t) => !t.relrowsecurity)).toEqual([]);
  });

  it("grants anon select on the four digest tables and nothing else", async () => {
    // The revoke block is the half that matters on Supabase, where default
    // privileges really do hand anon table grants -- and locally it revokes
    // nothing, because nothing was granted. Assert the resulting privileges
    // directly; the denial tests above cannot tell the two situations apart.
    const granted = await sql<{ relname: string; readable: boolean }[]>`
      select c.relname, has_table_privilege('anon', c.oid, 'select') as readable
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname <> '_migration'
      order by c.relname
    `;
    // digest is absent because its grant is column-level, which
    // has_table_privilege deliberately does not report as table select. The
    // next test covers it.
    expect(granted.filter((t) => t.readable).map((t) => t.relname)).toEqual([
      "change_event",
      "digest_item",
      "event_source",
    ]);
  });

  it("withholds subscriber_id from anon even on a table it can read", async () => {
    // digest is granted column-by-column: the reader never selects
    // subscriber_id, and a public bundle has no business enumerating which
    // subscribers exist.
    expect(
      await sql`select has_column_privilege('anon', 'digest', 'window_end', 'select') as ok`,
    ).toMatchObject([{ ok: true }]);
    expect(
      await sql`select has_column_privilege('anon', 'digest', 'subscriber_id', 'select') as ok`,
    ).toMatchObject([{ ok: false }]);
  });

  it("does not leave public functions executable by anon", async () => {
    const executable = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
    `;
    expect(executable).toMatchObject([{ n: 0 }]);
  });

  it("grants anon a read policy on exactly the four digest tables", async () => {
    const policies = await sql<{ tablename: string; cmd: string; roles: string[] }[]>`
      select tablename, cmd, roles::text[] from pg_policies
      where schemaname = 'public' order by tablename
    `;
    expect(policies).toMatchObject([
      { tablename: "change_event", cmd: "SELECT", roles: ["anon"] },
      { tablename: "digest", cmd: "SELECT", roles: ["anon"] },
      { tablename: "digest_item", cmd: "SELECT", roles: ["anon"] },
      { tablename: "event_source", cmd: "SELECT", roles: ["anon"] },
    ]);
  });
});

describe("the pipeline owner", () => {
  it("is unaffected by RLS", async () => {
    const subscribers = await sql`select email from subscriber`;
    expect(subscribers).toMatchObject([{ email: "operator@example.com" }]);
    const events = await sql`select count(*)::int as n from change_event`;
    expect(events).toMatchObject([{ n: 1 }]);
  });
});
