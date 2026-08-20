-- Slice F.2 (§6): row-level security, ahead of the reader talking to
-- PostgREST with the anon key. Every table gets RLS enabled; only the four
-- tables a digest is assembled from get a read policy. A table with RLS on
-- and no policy denies every row, which is the intended answer for
-- subscriber -- it holds email addresses and the confirm/unsubscribe tokens
-- from slice F.1, and the anon key ships inside the browser bundle.
--
-- The pipeline connects as the table owner, and an owner bypasses RLS
-- (no table is set to `force row level security`), so ingest, digest
-- assembly and delivery are unaffected by anything below.
--
-- Supabase provisions the `anon` role; the local Docker Postgres in
-- scripts/dev-db.ts does not, so create it when it is missing. That keeps
-- the migration runnable against both, and lets the integration test reach
-- the policies with `set role anon` instead of needing a REST layer.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
end
$$;

grant usage on schema public to anon;

alter table subscriber enable row level security;
alter table subscription enable row level security;
alter table source enable row level security;
alter table source_state enable row level security;
alter table change_event enable row level security;
alter table event_source enable row level security;
alter table digest enable row level security;
alter table digest_item enable row level security;
alter table delivery enable row level security;

-- Readable: the digest and the events it points at.
--
-- The predicate is `true`, and not because there is nothing to filter on --
-- digest.subscriber_id has been there since migration 1. It is because anon
-- cannot read `subscriber`, so it has no way to say which subscriber_id it
-- is entitled to. There is no identity to key on until #65, at which point
-- these become auth.uid() predicates over that column. Until then the
-- deployment is single-tenant, and a second subscriber would make every
-- digest readable by every visitor.
--
-- The grant on digest is column-level: subscriber_id and created_at are not
-- among the columns the reader selects, and withholding them keeps the
-- subscriber census out of reach of a public bundle.
grant select (id, cadence, window_start, window_end) on digest to anon;
grant select on change_event, event_source, digest_item to anon;

create policy anon_reads_change_event on change_event
  for select to anon using (true);
create policy anon_reads_event_source on event_source
  for select to anon using (true);
create policy anon_reads_digest on digest
  for select to anon using (true);
create policy anon_reads_digest_item on digest_item
  for select to anon using (true);

-- Belt and braces: Supabase's default privileges hand `anon` table grants
-- in public, so withdraw them explicitly rather than leaning on RLS alone
-- to be the only thing standing between the browser and a subscriber row.
revoke all on subscriber from anon;
revoke all on subscription from anon;
revoke all on source from anon;
revoke all on source_state from anon;
revoke all on delivery from anon;

-- `grant usage on schema public` also reaches functions, and every function
-- carries a default EXECUTE grant to PUBLIC -- including the ones migration
-- 1's pgcrypto extension installs. Withdraw it, so a `security definer`
-- helper dropped into public later is not anon-callable the moment it is
-- created. The pipeline connects as the owner and is unaffected.
revoke execute on all functions in schema public from public;
