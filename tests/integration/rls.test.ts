// Slice F.2 (§6): the anon role sees the digest and nothing else.
//
// These run against the real policies rather than a REST layer: `set local
// role anon` inside a transaction puts the session on the same footing as
// PostgREST's anon request, which is what the browser bundle will be.
import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import type { CandidateEvent } from "../../src/core/types.ts";
import { type Queryable, connect } from "../../src/store/db.ts";
import { annotateItem, excludeEvent, includeEvent, setHeading } from "../../src/store/issue.ts";
import {
  assembleDigest,
  confirmSubscription,
  ensureOperator,
  ensureSource,
  ingestCandidates,
  linkOperator,
  requestSubscription,
  unlinkOperator,
  unsubscribe,
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

/** The auth user `operator link` connects to the operator, and one that is not linked. */
const OPERATOR_USER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const STRANGER_USER_ID = "9b2c1f55-7a3e-4d0b-8c1e-5f6a7b8c9d0e";

/**
 * The claims PostgREST would set for a verified token, defaulting to the
 * operator's auth user. Supabase writes `sub`, `email` and `app_metadata`; the
 * user edits `user_metadata`. Only `role` and `sub` are ever trusted.
 */
const claimsFor = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  role: "authenticated",
  sub: OPERATOR_USER_ID,
  ...overrides,
});

/**
 * Run one query as role `authenticated` with the given claims in the
 * transaction-local `request.jwt.claims` setting, as PostgREST does per request.
 */
const asAuthenticated = async <T>(
  claims: Record<string, unknown>,
  query: (tx: Queryable) => Promise<T>,
): Promise<T> =>
  (await sql.begin(async (tx) => {
    await tx.unsafe("set local role authenticated");
    await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
    return await query(tx);
  })) as T;

beforeEach(async () => {
  await sql`truncate issue, change_event, event_source, digest, digest_item, source_state, subscription, subscriber restart identity cascade`;
  await ensureSource(sql, "web-features", "artifact-diff");
  const subscriberId = await ensureOperator(sql, "operator@example.com");
  await linkOperator(sql, "operator@example.com", OPERATOR_USER_ID);
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

describe("anon sees only the operator's digest", () => {
  // Migration 7: the policy keys on subscriber.is_operator through a security
  // definer helper, because anon can neither read subscriber nor, per the
  // column grant, select digest.subscriber_id.
  it("reads the operator's digest and items but not another subscriber's", async () => {
    await requestSubscription(sql, "alice@example.com");
    const [alice] = await sql<{ id: string; confirm_token: string }[]>`
      select id, confirm_token from subscriber where email = 'alice@example.com'
    `;
    await confirmSubscription(sql, alice!.confirm_token);
    const [operatorDigest] = await sql<{ id: string }[]>`
      select id from digest where subscriber_id = (select id from subscriber where is_operator)
    `;
    const [aliceDigest] = await sql<{ id: string }[]>`
      insert into digest (subscriber_id, cadence, window_start, window_end)
      values (${alice!.id}, 'daily', now() - interval '1 day', now() + interval '1 day')
      returning id
    `;
    const [event] = await sql<{ id: string }[]>`select id from change_event limit 1`;
    await sql`
      insert into digest_item (digest_id, event_id, position)
      values (${aliceDigest!.id}, ${event!.id}, 0)
    `;
    expect(await sql`select count(*)::int as n from digest`).toMatchObject([{ n: 2 }]);
    expect(await sql`select count(*)::int as n from digest_item`).toMatchObject([{ n: 2 }]);

    expect(await asAnon((tx) => tx`select id from digest`)).toEqual([{ id: operatorDigest!.id }]);
    expect(await asAnon((tx) => tx`select digest_id from digest_item`)).toEqual([
      { digest_id: operatorDigest!.id },
    ]);
    // Public facts stay readable whoever's digest points at them.
    expect(await asAnon((tx) => tx`select id from change_event`)).toHaveLength(1);
    expect(await asAnon((tx) => tx`select url from event_source`)).toHaveLength(1);
    await expect(asAnon((tx) => tx.unsafe("select * from subscriber"))).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("can execute the helper, which answers only for the operator's id", async () => {
    const [{ id: operatorId }] = await sql<
      { id: string }[]
    >`select id from subscriber where is_operator`;
    await requestSubscription(sql, "alice@example.com");
    const [{ id: aliceId }] = await sql<{ id: string }[]>`
      select id from subscriber where email = 'alice@example.com'
    `;
    const answer = (id: string) =>
      asAnon(async (tx) => (await tx`select is_operator_subscriber(${id}::uuid) as ok`)[0]!.ok);
    expect(await answer(operatorId)).toBe(true);
    expect(await answer(aliceId)).toBe(false);
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

describe("anon signup", () => {
  // The browser's whole write path. The function is security definer, so anon
  // can queue a subscription without being able to read the table back.
  it("can request a subscription and still cannot read subscriber", async () => {
    await asAnon((tx) => requestSubscription(tx, "visitor@example.com"));

    const rows =
      await sql`select email, confirmed_at from subscriber where email = 'visitor@example.com'`;
    expect(rows).toMatchObject([{ email: "visitor@example.com", confirmed_at: null }]);

    await expect(asAnon((tx) => tx.unsafe("select * from subscriber"))).rejects.toThrow(
      /permission denied/i,
    );
    await expect(
      asAnon((tx) => tx.unsafe("insert into subscriber (email) values ('direct@example.com')")),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("anon confirm and unsubscribe", () => {
  // The two email links reach `subscriber` the same way signup does: through a
  // security definer function, with the table itself still closed to anon.
  it("can confirm and unsubscribe by token and still cannot read subscriber", async () => {
    await asAnon((tx) => requestSubscription(tx, "visitor@example.com"));
    const [row] = await sql<{ confirm_token: string; unsubscribe_token: string }[]>`
      select confirm_token, unsubscribe_token from subscriber where email = 'visitor@example.com'
    `;

    expect(await asAnon((tx) => confirmSubscription(tx, row!.confirm_token))).toBe(true);
    expect(await asAnon((tx) => unsubscribe(tx, row!.unsubscribe_token))).toBe(true);

    expect(
      await sql`select confirmed_at, unsubscribed_at from subscriber where email = 'visitor@example.com'`,
    ).toMatchObject([{ confirmed_at: expect.any(Date), unsubscribed_at: expect.any(Date) }]);

    await expect(asAnon((tx) => tx.unsafe("select * from subscriber"))).rejects.toThrow(
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
      "issue",
      "issue_delivery",
      "issue_item",
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

  it("holds no table-level privilege on digest, so the column grant restricts something", async () => {
    // Supabase's default privileges give anon table-level SELECT on every new
    // table, and a table-level grant makes the column grant pointless, since
    // PostgreSQL ORs the two. Migration 8 revokes it. Locally nothing grants
    // it to begin with, so this asserts the end state production must reach.
    expect(
      await sql`select has_table_privilege('anon', 'public.digest', 'select') as ok`,
    ).toMatchObject([{ ok: false }]);
    for (const column of ["subscriber_id", "created_at"]) {
      expect(
        await sql`select has_column_privilege('anon', 'public.digest', ${column}, 'select') as ok`,
      ).toMatchObject([{ ok: false }]);
    }
    expect(
      await sql`select has_column_privilege('anon', 'public.digest', 'id', 'select') as ok`,
    ).toMatchObject([{ ok: true }]);
  });

  it("leaves four functions as the only public ones anon can execute", async () => {
    // Migration 4 withdrew EXECUTE from PUBLIC; migrations 5 and 6 grant it
    // back to anon for signup, confirm and unsubscribe, and migration 7 for
    // the helper the digest policies call. Any other name appearing here is a
    // function that became anon-callable by accident.
    const executable = await sql<{ proname: string }[]>`
      select p.proname from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
      order by p.proname
    `;
    expect(executable).toEqual([
      { proname: "confirm_subscription" },
      { proname: "is_operator_subscriber" },
      { proname: "request_subscription" },
      { proname: "unsubscribe" },
    ]);
  });

  it("grants anon a read policy on exactly the four digest tables", async () => {
    const policies = await sql<{ tablename: string; cmd: string; roles: string[] }[]>`
      select tablename, cmd, roles::text[] from pg_policies
      where schemaname = 'public' and roles @> array['anon']::name[] order by tablename
    `;
    expect(policies).toMatchObject([
      { tablename: "change_event", cmd: "SELECT", roles: ["anon"] },
      { tablename: "digest", cmd: "SELECT", roles: ["anon"] },
      { tablename: "digest_item", cmd: "SELECT", roles: ["anon"] },
      { tablename: "event_source", cmd: "SELECT", roles: ["anon"] },
    ]);
  });

  it("grants the operator a select policy on exactly four tables, and no policy on a write", async () => {
    const policies = await sql<{ tablename: string; cmd: string; roles: string[] }[]>`
      select tablename, cmd, roles::text[] from pg_policies
      where schemaname = 'public' and roles @> array['authenticated']::name[]
      order by tablename
    `;
    expect(policies).toMatchObject([
      { tablename: "change_event", cmd: "SELECT", roles: ["authenticated"] },
      { tablename: "event_source", cmd: "SELECT", roles: ["authenticated"] },
      { tablename: "issue", cmd: "SELECT", roles: ["authenticated"] },
      { tablename: "issue_item", cmd: "SELECT", roles: ["authenticated"] },
    ]);
  });

  const anonTablePrivileges = (db: Queryable) => db<{ relname: string; privilege: string }[]>`
    select c.relname, p.privilege
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'),
                       ('references'), ('trigger')) as p(privilege)
    where n.nspname = 'public' and c.relkind = 'r' and c.relname <> '_migration'
      and has_table_privilege('anon', c.oid, p.privilege)
    order by c.relname, p.privilege
  `;

  const ANON_SELECT_ONLY = [
    { relname: "change_event", privilege: "select" },
    { relname: "digest_item", privilege: "select" },
    { relname: "event_source", privilege: "select" },
  ];

  it("leaves anon with select on three tables and no other table privilege", async () => {
    // digest is absent on purpose: anon reads it through a column-level
    // grant, which has_table_privilege does not count.
    expect(await anonTablePrivileges(sql)).toEqual(ANON_SELECT_ONLY);
  });

  it("withdraws the table privileges a Supabase project hands anon by default", async () => {
    // The local database grants nothing by default, so the state production
    // was found in is recreated here before migration 11 is run again. The
    // transaction is rolled back, so no other test sees the wide grant.
    const migration = readFileSync(
      new URL("../../supabase/migrations/00000000000011_anon_select_only.sql", import.meta.url),
      "utf8",
    );
    await expect(
      sql.begin(async (tx) => {
        await tx`grant all on change_event, event_source, digest_item to anon`;
        const wide = await anonTablePrivileges(tx);
        expect(wide).toContainEqual({ relname: "change_event", privilege: "truncate" });

        await tx.unsafe(migration);

        expect(await anonTablePrivileges(tx)).toEqual(ANON_SELECT_ONLY);
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
  });

  it("gives authenticated select on four tables and no write privilege anywhere", async () => {
    // Supabase's default privileges would hand authenticated every grant on
    // every table; locally nothing is granted by default, so assert the end
    // state the migrations must reach there.
    const privileges = await sql<{ relname: string; privilege: string }[]>`
      select c.relname, p.privilege
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'),
                         ('references'), ('trigger')) as p(privilege)
      where n.nspname = 'public' and c.relkind = 'r' and c.relname <> '_migration'
        and has_table_privilege('authenticated', c.oid, p.privilege)
      order by c.relname, p.privilege
    `;
    expect(privileges).toEqual([
      { relname: "change_event", privilege: "select" },
      { relname: "event_source", privilege: "select" },
      { relname: "issue", privilege: "select" },
      { relname: "issue_item", privilege: "select" },
    ]);
    // No column-level grant sneaks digest.subscriber_id back in.
    for (const table of ["digest", "subscriber", "subscription", "delivery", "issue_delivery"]) {
      const columns = await sql<{ attname: string }[]>`
        select a.attname from pg_attribute a
        where a.attrelid = ${`public.${table}`}::regclass and a.attnum > 0 and not a.attisdropped
          and has_column_privilege('authenticated', a.attrelid, a.attnum, 'select')
      `;
      expect(columns, table).toEqual([]);
    }
  });

  it("leaves authenticated with exactly the four curation functions and the identity check", async () => {
    const executable = await sql<{ proname: string }[]>`
      select p.proname from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
      order by p.proname
    `;
    expect(executable).toEqual([
      { proname: "is_operator_request" },
      { proname: "issue_annotate_item" },
      { proname: "issue_exclude_event" },
      { proname: "issue_include_event" },
      { proname: "issue_set_heading" },
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

describe("the operator's curation access", () => {
  // The identity check reads request.jwt.claims, which PostgREST fills from
  // the verified token. These tests set the same setting by hand, so they
  // exercise the real policies and functions without a REST layer.
  let issueId: string;
  let eventId: string;

  beforeEach(async () => {
    [{ id: eventId }] = await sql<{ id: string }[]>`select id from change_event limit 1`;
    [{ id: issueId }] = await sql<{ id: string }[]>`
      insert into issue (number, window_start, window_end)
      values (1, now() - interval '1 day', now() + interval '1 day') returning id
    `;
    await includeEvent(sql, issueId, eventId);
  });

  const readable = ["issue", "issue_item", "change_event", "event_source"] as const;

  it("lets the operator's auth user read the four tables", async () => {
    for (const table of readable) {
      const rows = await asAuthenticated(claimsFor(), (tx) => tx.unsafe(`select * from ${table}`));
      expect(rows.length, table).toBe(1);
    }
  });

  it("lets the operator call all four write functions", async () => {
    await asAuthenticated(claimsFor(), async (tx) => {
      await setHeading(tx, issueId, "Title", "Intro");
      await annotateItem(tx, issueId, eventId, "A note", "lead");
      await excludeEvent(tx, issueId, eventId);
      await includeEvent(tx, issueId, eventId);
    });
    expect(await sql`select title, intro from issue`).toMatchObject([
      { title: "Title", intro: "Intro" },
    ]);
    expect(await sql`select note, section, included from issue_item`).toMatchObject([
      { note: "A note", section: "lead", included: true },
    ]);
  });

  const answer = (claims: Record<string, unknown>) =>
    asAuthenticated(
      claims,
      async (tx) => (await tx`select public.is_operator_request() as ok`)[0]!.ok,
    );

  it("answers is_operator_request true for the linked auth user, and false with no token", async () => {
    expect(await answer(claimsFor())).toBe(true);
    // A uuid is the same uuid in either case.
    expect(await answer(claimsFor({ sub: OPERATOR_USER_ID.toUpperCase() }))).toBe(true);
    expect(await answer(claimsFor({ sub: STRANGER_USER_ID }))).toBe(false);

    const noToken = await sql.begin(async (tx) => {
      await tx.unsafe("set local role authenticated");
      return (await tx`select public.is_operator_request() as ok`)[0]!.ok;
    });
    expect(noToken).toBe(false);
  });

  it("allows the right sub whatever email, app_metadata and user_metadata the token carries", async () => {
    // None of them is read, so none can make a difference either way.
    expect(
      await answer(
        claimsFor({
          email: "someone-else@example.com",
          app_metadata: { provider: "email", providers: ["email"] },
          user_metadata: { sub: STRANGER_USER_ID },
        }),
      ),
    ).toBe(true);
  });

  // The malformed values are answered, not raised: a cast of `sub` to uuid
  // would throw on every one of them.
  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["not a uuid", "not-a-uuid"],
    ["a uuid with a character too many", `${OPERATOR_USER_ID}0`],
    ["a uuid in braces", `{${OPERATOR_USER_ID}}`],
    ["a number", 12345],
    ["an object", { id: OPERATOR_USER_ID }],
  ])("answers false, without an error, when sub is %s", async (_name, sub) => {
    const claims = claimsFor({ sub });
    expect(await answer(claims)).toBe(false);
    for (const table of readable) {
      expect(
        await asAuthenticated(claims, (tx) => tx.unsafe(`select * from ${table}`)),
        table,
      ).toHaveLength(0);
    }
  });

  // Each of these presents something the old check trusted, or a token that
  // fails one check, and none of them is the operator's auth user.
  const impostors: [string, Record<string, unknown>][] = [
    [
      "the operator's email with another auth user's sub",
      claimsFor({ sub: STRANGER_USER_ID, email: "operator@example.com" }),
    ],
    [
      "the operator's email and a google provider with another auth user's sub",
      claimsFor({
        sub: STRANGER_USER_ID,
        email: "operator@example.com",
        app_metadata: { provider: "google", providers: ["google"] },
      }),
    ],
    [
      "a user_metadata that names the operator's sub while the real sub differs",
      claimsFor({
        sub: STRANGER_USER_ID,
        user_metadata: { sub: OPERATOR_USER_ID, email: "operator@example.com" },
      }),
    ],
    [
      "a token with no sub that names the operator in user_metadata",
      claimsFor({ sub: undefined, user_metadata: { sub: OPERATOR_USER_ID } }),
    ],
    ["the operator's sub with role anon", claimsFor({ role: "anon" })],
    ["the operator's sub with no role", claimsFor({ role: undefined })],
  ];

  it.each(impostors)("denies %s", async (_name, claims) => {
    for (const table of readable) {
      expect(
        await asAuthenticated(claims, (tx) => tx.unsafe(`select * from ${table}`)),
        table,
      ).toHaveLength(0);
    }
    const denied = /only the operator may curate an issue/;
    await expect(
      asAuthenticated(claims, (tx) => setHeading(tx, issueId, "Hijacked", "")),
    ).rejects.toThrow(denied);
    await expect(
      asAuthenticated(claims, (tx) => annotateItem(tx, issueId, eventId, "Hijacked", "lead")),
    ).rejects.toThrow(denied);
    await expect(
      asAuthenticated(claims, (tx) => excludeEvent(tx, issueId, eventId)),
    ).rejects.toThrow(denied);
    await expect(
      asAuthenticated(claims, (tx) => includeEvent(tx, issueId, eventId)),
    ).rejects.toThrow(denied);
    expect(
      await sql`select title, note, included from issue join issue_item on true`,
    ).toMatchObject([{ title: "", note: null, included: true }]);
  });

  it("denies everyone while the operator is unlinked", async () => {
    expect(await unlinkOperator(sql, "operator@example.com")).toBe("unlinked");

    expect(await answer(claimsFor())).toBe(false);
    expect(await answer(claimsFor({ sub: null }))).toBe(false);
    expect(await asAuthenticated(claimsFor(), (tx) => tx`select id from issue`)).toHaveLength(0);
  });

  it("stops honouring the old link once ensureOperator moves the flag, until the new operator is linked", async () => {
    expect(await answer(claimsFor())).toBe(true);

    await ensureOperator(sql, "new-operator@example.com");

    // The old operator's account is no longer the operator, and the new
    // operator is nobody's account yet.
    expect(await answer(claimsFor())).toBe(false);
    expect(await answer(claimsFor({ sub: STRANGER_USER_ID }))).toBe(false);
    expect(await asAuthenticated(claimsFor(), (tx) => tx`select id from issue`)).toHaveLength(0);
    await expect(
      asAuthenticated(claimsFor(), (tx) => setHeading(tx, issueId, "Hijacked", "")),
    ).rejects.toThrow(/only the operator may curate an issue/);

    await linkOperator(sql, "new-operator@example.com", STRANGER_USER_ID);
    expect(await answer(claimsFor({ sub: STRANGER_USER_ID }))).toBe(true);
    expect(await answer(claimsFor())).toBe(false);

    // Moving the flag back does not bring the first link back either.
    await ensureOperator(sql, "operator@example.com");
    expect(await answer(claimsFor())).toBe(false);
    expect(await answer(claimsFor({ sub: STRANGER_USER_ID }))).toBe(false);
  });

  // `using (is_operator_request())` is a call Postgres makes for every row it
  // examines, and it cannot be skipped or hoisted because the function is
  // `security definer`. `using ((select is_operator_request()))` is an
  // uncorrelated subquery, which the planner runs once as an InitPlan and then
  // reuses. The plan is the observable difference, so it is what this checks.
  it.each(readable)(
    "evaluates the operator check once per query, not once per row, on %s",
    async (table) => {
      const plan = await asAuthenticated(claimsFor(), async (tx) =>
        (await tx.unsafe(`explain (costs off) select * from ${table}`))
          .map((row) => String(row["QUERY PLAN"]))
          .join("\n"),
      );

      expect(plan).toMatch(/InitPlan/);
      // The call itself sits in the InitPlan, not in the per-row filter.
      expect(plan).not.toMatch(/Filter: .*is_operator_request/);
    },
  );

  it("denies authenticated, operator or not, the tables a subscriber's data lives in", async () => {
    for (const claims of [claimsFor(), claimsFor({ sub: STRANGER_USER_ID })]) {
      for (const table of ["subscriber", "subscription", "delivery", "issue_delivery", "digest"]) {
        await expect(
          asAuthenticated(claims, (tx) => tx.unsafe(`select * from ${table}`)),
          table,
        ).rejects.toThrow(/permission denied/i);
      }
      await expect(
        asAuthenticated(claims, (tx) => tx.unsafe("select subscriber_id from digest")),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        asAuthenticated(claims, (tx) => tx.unsafe("select id from digest_item")),
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it("cannot write the issue tables directly, even as the operator", async () => {
    for (const statement of [
      "update issue set title = 'direct'",
      "insert into issue_item (issue_id, event_id, position, section) select id, (select id from change_event limit 1), 99, 'lead' from issue",
      "delete from issue_item",
      "update change_event set title = 'direct'",
    ]) {
      await expect(
        asAuthenticated(claimsFor(), (tx) => tx.unsafe(statement)),
        statement,
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it("denies anon the issue tables, issue_delivery and every curation function", async () => {
    for (const table of ["issue", "issue_item", "issue_delivery"]) {
      await expect(
        asAnon((tx) => tx.unsafe(`select * from ${table}`)),
        table,
      ).rejects.toThrow(/permission denied/i);
    }
    await expect(asAnon((tx) => setHeading(tx, issueId, "anon", ""))).rejects.toThrow(
      /permission denied/i,
    );
    await expect(asAnon((tx) => includeEvent(tx, issueId, eventId))).rejects.toThrow(
      /permission denied/i,
    );
    await expect(asAnon((tx) => tx`select public.is_operator_request()`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("lets only the table owner read issue_delivery", async () => {
    expect(await sql`select count(*)::int as n from issue_delivery`).toMatchObject([{ n: 0 }]);
  });
});
