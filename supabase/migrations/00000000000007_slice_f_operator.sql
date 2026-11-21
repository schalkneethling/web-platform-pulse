-- Slice F.11 (#65): the operator becomes an explicit identity, and the public
-- reader shows the operator's digest only.
--
-- Two things were only implied until now. "The operator" was whichever
-- subscriber's address sat in PULSE_SUBSCRIBER_EMAIL, back when that was the
-- only subscriber; nothing in the database marked them. And migration 4's
-- `using (true)` policies let anon read every digest, on the stated grounds
-- that the deployment was single-tenant. Public signup (migrations 5 and 6)
-- ended that: with several subscribers the reader showed whichever digest was
-- cut last, and every subscriber's filtered digest was readable by any
-- visitor holding the public anon key.
--
-- The decision recorded here: the public reader shows the operator's digest
-- and no one else's. The operator's digest is the unfiltered public edition.
-- Every other subscriber receives their own filtered digest by email and has
-- no reader view. A per-subscriber view would need real authentication
-- (Supabase Auth, with `auth.uid()` predicates over digest.subscriber_id),
-- which is deferred to Slice G, because Slice G needs an authenticated
-- operator anyway and the two should share one identity mechanism.

-- The explicit marker. Existing rows default to false; the pipeline's
-- ensureOperator sets it on every run, so a database that predates this
-- column heals itself even if the backfill below guessed wrong.
alter table subscriber add column is_operator boolean not null default false;

-- At most one operator. A partial unique index over a constant indexes only
-- the rows where is_operator is true, so any number of rows may be false but
-- a second true is a unique violation. The database, not the application,
-- enforces the invariant.
create unique index subscriber_one_operator_idx on subscriber ((true)) where is_operator;

-- Backfill for databases that already exist: mark the earliest confirmed
-- subscriber. This assumes the migration is applied before any public
-- subscriber can have confirmed, because the signup form ships in the same
-- release as this migration, so the earliest confirmed row is the operator.
-- The ordering is only a one-time guess for that window; afterwards the flag
-- is the source of truth and "earliest" means nothing.
update subscriber set is_operator = true
where id = (
  select id from subscriber
  where confirmed_at is not null
  order by created_at, id
  limit 1
);

-- The policies below must ask "does this digest belong to the operator?", and
-- anon cannot read `subscriber`, so the question goes through a function that
-- runs with its owner's privileges. `set search_path = ''` and the
-- schema-qualified table follow migration 5's reasoning.
--
-- It takes an id and returns a boolean, rather than returning the operator's
-- id. A caller can already see digest ids it is entitled to, so "this id is
-- the operator's" tells it nothing it could not infer, whereas a function
-- returning the operator's id would hand anon a subscriber identifier.
create function is_operator_subscriber(candidate uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.subscriber where id = candidate and is_operator
  );
$$;

-- Created after migration 4's blanket revoke, so it carries the default
-- PUBLIC grant again: withdraw it, then grant anon alone. This is the fourth
-- public function the browser may execute (with request_subscription,
-- confirm_subscription and unsubscribe), and the only one the policies need.
revoke execute on function is_operator_subscriber(uuid) from public;
grant execute on function is_operator_subscriber(uuid) to anon;

-- Replace migration 4's permissive policies. change_event and event_source
-- keep `using (true)`: those rows are public facts about the web platform,
-- the same for every subscriber, and they carry no subscriber data.
drop policy anon_reads_digest on digest;
drop policy anon_reads_digest_item on digest_item;

-- Only the operator's digests. Migration 4's column grant on digest still
-- withholds subscriber_id from anon, and the policy can use that column
-- regardless: PostgreSQL does not apply column privileges to the columns a
-- policy expression refers to. The integration tests assert it, because the
-- policy would otherwise hide every digest from the reader.
create policy anon_reads_digest on digest
  for select to anon using (is_operator_subscriber(subscriber_id));

-- A digest item is readable exactly when its digest is. The subquery on
-- `digest` is itself filtered by the policy above for the same role, so the
-- operator rule is written once and digest_item follows it.
create policy anon_reads_digest_item on digest_item
  for select to anon using (
    exists (select 1 from digest where digest.id = digest_item.digest_id)
  );
