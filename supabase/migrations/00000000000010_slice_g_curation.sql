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
-- question in both.
--
-- The operator is identified by the auth user id, not by an email address.
-- The `email` claim is the account's primary email, which its owner can change
-- and which another account can come to hold; `app_metadata.providers` lists
-- every provider linked to the account, not the one used to sign in. Neither
-- proves "this is the operator signing in with Google". The `sub` claim is the
-- auth user's id: it never changes for the life of the account and no one
-- can pick it. So `subscriber.auth_user_id` records which auth user is the
-- operator, and the check compares `sub` with it.
--
-- The column is nullable and is set by `operator link <auth-user-id>` (see
-- src/cli/operator.ts) after the operator has signed in once and read their id
-- off /curate. Until it is set, nobody is the browser operator. `ensureOperator`
-- clears it when the operator flag moves to another subscriber, so a link
-- never outlives the address it was made for. It is unique, so one auth user
-- cannot be linked to two subscribers.
--
-- `subscriber` was created in migration 3, hence an `alter table`. Neither
-- `anon` nor `authenticated` has any grant on the table (migrations 4 and 8),
-- so the column is as unreadable as the rest.
alter table subscriber add column auth_user_id uuid unique;

-- Two claims must agree:
--   * `role` is `authenticated`, so an anon token cannot qualify;
--   * `sub` is the `auth_user_id` of the subscriber marked `is_operator`.
-- Nothing else in the token is read. In particular `email`, `app_metadata` and
-- `user_metadata` are ignored: the last is editable by the user.
--
-- `sub` is compared as text with the uuid's canonical lower-case form rather
-- than cast to uuid. A cast raises on a malformed value, which would turn a
-- hostile or broken token into a database error instead of a plain "no"; the
-- comparison simply never matches. `lower` accepts an upper-case uuid.
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
        and s.auth_user_id is not null
        and c.claims ->> 'role' = 'authenticated'
        and s.auth_user_id::text = lower(c.claims ->> 'sub')
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
-- need the vocabulary to validate it.
--
-- The two copies of the mapping can drift, and two things catch it. Every type
-- is listed explicitly and there is no default branch: a type that exists in
-- TypeScript and not here makes the include raise, naming the type, instead of
-- quietly landing in `watch`. And the integration test derives its list of
-- types from a `Record<ChangeEventType, Section>`, so a new type fails to
-- compile there until it is listed, and fails at run time until this function
-- knows it.
create function issue_include_event(target_issue uuid, target_event uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  draft public.issue%rowtype;
  candidate public.change_event%rowtype;
  item_section text;
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

  item_section := case candidate.type
    when 'editorial' then 'voices'
    when 'baseline-change' then 'shipped'
    when 'browser-support' then 'shipped'
    when 'browser-release' then 'shipped'
    when 'runtime-release' then 'shipped'
    when 'spec-change' then 'watch'
    when 'vendor-position' then 'watch'
    when 'feature-status' then 'watch'
    when 'tag-review' then 'watch'
  end;
  if item_section is null then
    raise exception 'change event type "%" has no section: add it to issue_include_event and to sectionFor',
      candidate.type using errcode = '22023';
  end if;

  insert into public.issue_item (issue_id, event_id, position, section)
  values (
    target_issue,
    target_event,
    coalesce((select max(position) from public.issue_item where issue_id = target_issue), 0) + 1,
    item_section
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
