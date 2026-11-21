-- Slice G.2 (#68): curating a draft issue from the browser.
--
-- Two things arrive together because neither is useful alone: an identity the
-- database can check ("is this request the operator?") and the writes that
-- identity is allowed to make.
--
-- The reader writes through PostgREST while the CLI and the tests write
-- through postgres.js as the table owner, so the rules live once, in four SQL
-- functions both paths call. No API role receives insert, update or delete
-- on the issue tables: a function that checks the draft status and the
-- operator is the only door.

-- 0. The `authenticated` role.
--
-- Supabase provisions it for signed-in users; the local Docker Postgres in
-- scripts/dev-db.ts does not, so create it when it is missing, the way
-- migration 4 does for `anon`. That keeps this migration runnable on both and
-- lets the integration tests reach the policies with `set role authenticated`.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
end
$$;

grant usage on schema public to authenticated;

-- 1. Who is the operator.
--
-- Production runs Supabase Auth with the Google provider and local
-- development runs PostgREST alone, but both put the verified token's claims
-- in the Postgres setting `request.jwt.claims`, so one function answers the
-- question in both. Three claims must agree:
--   * `role` is `authenticated`, so an anon token cannot qualify;
--   * `email` matches the subscriber marked `is_operator`;
--   * `app_metadata.providers` contains `google`. The email claim alone would
--     also be satisfied by someone who registered that address with a
--     password, so the provider is what ties it to the operator's Google
--     account. `app_metadata` is written only by the auth server; the
--     `user_metadata` claim is editable by the user and is never read here.
--
-- `current_setting(..., true)` returns null instead of raising when the
-- setting does not exist, and `nullif(..., '')` covers a session that set it
-- and then cleared it, so a connection with no token answers false.
--
-- It is `security definer` because the caller cannot read `subscriber`.
create function is_operator_request()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select true
      from public.subscriber s,
        lateral (select nullif(current_setting('request.jwt.claims', true), '')::jsonb as claims) c
      where s.is_operator
        and lower(s.email) = lower(c.claims ->> 'email')
        and c.claims ->> 'role' = 'authenticated'
        and (c.claims -> 'app_metadata' -> 'providers') ? 'google'
    ),
    false
  );
$$;

revoke execute on function is_operator_request() from public;
revoke execute on function is_operator_request() from anon;
grant execute on function is_operator_request() to authenticated;

-- 2. Reads for the operator.
--
-- The curation view lists the window's events next to the issue's items, so
-- the operator may read the issue, its items, and the same two event tables
-- anon already reads. Each policy names `authenticated`, so anon's policies
-- on the two event tables are untouched.
--
-- Supabase's default privileges can hand `authenticated` every grant on a
-- new table, so withdraw them from the two older tables before granting
-- select, the way migration 8 did for the rest. `digest`, `subscriber`,
-- `subscription`, `delivery` and `issue_delivery` are already revoked by
-- migrations 8 and 9 and receive nothing here.
revoke all on change_event, event_source from authenticated;
grant select on issue, issue_item, change_event, event_source to authenticated;

create policy operator_reads_issue on issue
  for select to authenticated using (is_operator_request());
create policy operator_reads_issue_item on issue_item
  for select to authenticated using (is_operator_request());
create policy operator_reads_change_event on change_event
  for select to authenticated using (is_operator_request());
create policy operator_reads_event_source on event_source
  for select to authenticated using (is_operator_request());

-- 3. Guards shared by the four writes.
--
-- `issue_require_curator` lets two kinds of caller through: the table owner
-- (the pipeline and the tests, which never switch role) and the operator.
-- PostgREST runs each request as `set local role <jwt role>`, and the tests do
-- the same, so the `role` setting is `none` exactly when no API role was
-- switched in. An API role cannot talk its way back to `none` and keep going:
-- `set role none` returns to the connecting role, which holds no execute
-- grant on the functions below.
create function issue_require_curator()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if current_setting('role') <> 'none' and not public.is_operator_request() then
    raise exception 'only the operator may curate an issue' using errcode = '42501';
  end if;
end;
$$;

-- Locks the issue row so two curators cannot interleave (two includes would
-- otherwise both compute the same max(position) + 1), and rejects a published
-- issue. A published issue was sent to subscribers, so editing it afterwards
-- would make the archive disagree with the inbox.
create function issue_lock_draft(target_issue uuid)
returns public.issue
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked public.issue%rowtype;
begin
  select * into locked from public.issue where id = target_issue for update;
  if not found then
    raise exception 'issue % does not exist', target_issue using errcode = 'P0002';
  end if;
  if locked.status <> 'draft' then
    raise exception 'issue % is published and can no longer be edited', locked.number
      using errcode = '55000';
  end if;
  return locked;
end;
$$;

revoke execute on function issue_require_curator() from public, anon, authenticated;
revoke execute on function issue_lock_draft(uuid) from public, anon, authenticated;

-- 4. The four writes.

-- Includes an event in the draft: sets `included` on an existing row, which
-- keeps any note the operator wrote before excluding it, or inserts a new row
-- at the end. The section comes from the event type here in SQL, repeating
-- `sectionFor` in src/core/issue.ts minus `lead`, because passing it in would
-- let the browser pick any section on include and the function would still
-- need the vocabulary to validate it. An integration test compares this
-- mapping with `sectionFor` for every event type, so the two cannot drift
-- unnoticed.
create function issue_include_event(target_issue uuid, target_event uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  draft public.issue%rowtype;
  candidate public.change_event%rowtype;
begin
  perform public.issue_require_curator();
  draft := public.issue_lock_draft(target_issue);

  select * into candidate from public.change_event where id = target_event;
  if not found then
    raise exception 'event % does not exist', target_event using errcode = 'P0002';
  end if;
  -- The window is half-open, the same range `issue open` selects from.
  if candidate.first_observed_at < draft.window_start
     or candidate.first_observed_at >= draft.window_end then
    raise exception 'event % was not observed in the window of issue %', target_event, draft.number
      using errcode = '22023';
  end if;

  update public.issue_item set included = true
    where issue_id = target_issue and event_id = target_event;
  if found then
    return;
  end if;

  insert into public.issue_item (issue_id, event_id, position, section)
  values (
    target_issue,
    target_event,
    coalesce((select max(position) from public.issue_item where issue_id = target_issue), 0) + 1,
    case candidate.type
      when 'editorial' then 'voices'
      when 'baseline-change' then 'shipped'
      when 'browser-support' then 'shipped'
      when 'browser-release' then 'shipped'
      when 'runtime-release' then 'shipped'
      else 'watch'
    end
  );
end;
$$;

-- Excluding an event that never had a row is a no-op: the end state, "not in
-- the issue", already holds, and failing would make a double click in the
-- browser an error.
create function issue_exclude_event(target_issue uuid, target_event uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.issue_require_curator();
  perform public.issue_lock_draft(target_issue);
  update public.issue_item set included = false
    where issue_id = target_issue and event_id = target_event;
end;
$$;

-- Sets an item's note and section. `btrim` strips only the characters it is
-- given and defaults to spaces, so the trim set names tab and line breaks too:
-- an operator's note often ends in a newline. A blank note is stored as null so
-- "un-annotated" has one representation in the database. The length cap is
-- the check constraint on issue_item.note and the section vocabulary is the
-- one on issue_item.section; both raise on a bad value, so this function does
-- not repeat them. An item that has no row cannot be annotated, because
-- including it is a separate decision.
create function issue_annotate_item(
  target_issue uuid,
  target_event uuid,
  new_note text,
  new_section text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.issue_require_curator();
  perform public.issue_lock_draft(target_issue);
  update public.issue_item
    set note = nullif(btrim(new_note, E' \t\r\n'), ''), section = new_section
    where issue_id = target_issue and event_id = target_event;
  if not found then
    raise exception 'event % is not an item of this issue', target_event using errcode = 'P0002';
  end if;
end;
$$;

-- Sets the title and the intro. They are trimmed, and null is stored as the
-- empty string those columns default to. The caps (200 and 4000 characters)
-- are the check constraints from migration 9.
create function issue_set_heading(target_issue uuid, new_title text, new_intro text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.issue_require_curator();
  perform public.issue_lock_draft(target_issue);
  update public.issue
    set title = coalesce(btrim(new_title, E' \t\r\n'), ''), intro = coalesce(btrim(new_intro, E' \t\r\n'), '')
    where id = target_issue;
end;
$$;

-- Functions are created with a default EXECUTE grant to PUBLIC, and
-- Supabase's default privileges can add direct grants to the API roles, so
-- withdraw all of them and then grant `authenticated` alone. Anon never gets
-- these: the public reader has no business curating anything.
revoke execute on function issue_include_event(uuid, uuid) from public, anon, authenticated;
revoke execute on function issue_exclude_event(uuid, uuid) from public, anon, authenticated;
revoke execute on function issue_annotate_item(uuid, uuid, text, text)
  from public, anon, authenticated;
revoke execute on function issue_set_heading(uuid, text, text) from public, anon, authenticated;

grant execute on function issue_include_event(uuid, uuid) to authenticated;
grant execute on function issue_exclude_event(uuid, uuid) to authenticated;
grant execute on function issue_annotate_item(uuid, uuid, text, text) to authenticated;
grant execute on function issue_set_heading(uuid, text, text) to authenticated;
