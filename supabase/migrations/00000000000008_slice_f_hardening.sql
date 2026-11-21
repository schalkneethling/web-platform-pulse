-- Slice F.12: hardening found in review of slice F.8 to F.11.
--
-- Two unrelated objects change here: the address check in request_subscription
-- gets stricter, and the grants on digest (and the unused `authenticated`
-- role) are tightened so they restrict anything on Supabase, not only locally.

-- 0. When the current signup was requested.
--
-- The cleanup in src/store/store.ts deletes subscribers who never confirmed
-- and asked more than 7 days ago. `created_at` cannot say when they asked: a
-- subscriber who confirmed a year ago, unsubscribed, and requests the digest
-- again has `confirmed_at` null once more and a `created_at` a year old, so a
-- cleanup keyed on it would delete them minutes after they asked, before the
-- confirmation email could be read. `requested_at` restarts whenever a signup
-- is (re)requested, and request_subscription below maintains it.
alter table subscriber add column requested_at timestamptz not null default now();

-- 1. A stricter address check.
--
-- Migration 5 accepted anything of the shape x@y.z with no whitespace or
-- second @, which let through junk such as `a@b..c` and `<x>,y@-.-`. Junk
-- addresses cost real mail attempts, so the check now follows the common
-- subset of RFC 5321 that mail servers accept:
--   * exactly one `@`, because neither part below may contain one;
--   * a local part of 1 to 64 characters, made of letters, digits and
--     ``.!#$%&'*+/=?^_`{|}~-``, with no leading, trailing or doubled dot;
--   * a domain of at least two dot-separated labels, each made of letters,
--     digits and hyphens, and neither starting nor ending with a hyphen.
-- The address is lower-cased first, so only the lower-case letter range
-- matters for the domain; the local part keeps both ranges for clarity.
--
-- Everything else about the function is as migration 5 left it, including the
-- signature, so `create or replace` keeps its owner and the grants are
-- restated below only because they are cheap to state and easy to lose.
create or replace function request_subscription(requested_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalised text := lower(trim(requested_email));
  existing public.subscriber%rowtype;
  inserted_id uuid;
begin
  if normalised is null
     or length(normalised) < 3
     or length(normalised) > 254
     or length(split_part(normalised, '@', 1)) > 64
     or normalised !~ (
       '^[A-Za-z0-9!#$%&''*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&''*+/=?^_`{|}~-]+)*'
       || '@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
     ) then
    raise exception 'invalid email address' using errcode = '22023';
  end if;

  -- `for update` serialises two simultaneous requests for one address.
  select * into existing from public.subscriber where lower(email) = normalised for update;

  if not found then
    insert into public.subscriber (email) values (normalised)
      on conflict do nothing
      returning id into inserted_id;
    if inserted_id is not null then
      insert into public.subscription (subscriber_id) values (inserted_id);
    end if;
    return;
  end if;

  if existing.unsubscribed_at is not null then
    update public.subscriber
      set unsubscribed_at = null,
          confirmed_at = null,
          confirm_token = gen_random_uuid(),
          confirmation_sent_at = null,
          confirmation_attempts = 0,
          requested_at = now()
      where id = existing.id;
  elsif existing.confirmed_at is not null then
    null;
  elsif existing.confirmation_sent_at is not null
        and existing.confirmation_sent_at < now() - interval '1 day'
        and existing.confirmation_attempts < 3 then
    update public.subscriber set confirmation_sent_at = null where id = existing.id;
  end if;
end;
$$;

revoke execute on function request_subscription(text) from public;
grant execute on function request_subscription(text) to anon;

-- 2. The column grant on digest restricted nothing on Supabase.
--
-- Migration 4 granted anon four columns of digest but never revoked the
-- table-level SELECT. Supabase's default privileges give `anon` SELECT on
-- every table created in public, and PostgreSQL ORs a table-level privilege
-- with column-level ones, so in production anon could also select
-- subscriber_id and created_at. Locally the role has no default grants, which
-- is why the tests passed. Revoking everything and then restating migration
-- 4's column grant leaves exactly those four columns; the grant is repeated
-- because `revoke all` removes column privileges as well.
revoke all on digest from anon;
grant select (id, cadence, window_start, window_end) on digest to anon;

-- Supabase also provisions `authenticated`, and its default privileges give
-- that role the same table grants. Nothing uses it yet (Slice G will bring
-- Supabase Auth), so withdraw them now; Slice G can grant what it needs. The
-- role does not exist on the local Docker Postgres, hence the check.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on digest, digest_item, subscriber, subscription, source, source_state, delivery
      from authenticated;
  end if;
end
$$;
