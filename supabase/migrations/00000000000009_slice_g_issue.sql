-- Slice G.1 (#66): the weekly issue. `digest` and `digest_item` are
-- per-subscriber machine output; an issue is one editorial artifact that one
-- person writes and every confirmed subscriber receives, so it gets its own
-- tables instead of new columns on those.
--
-- `change_event` is never written by anything here. An issue is a selection
-- over events, so a pipeline re-run cannot disturb a draft, and
-- `issue_item.event_id` has no cascade for the same reason.
--
-- Like every table since migration 4, these have row-level security enabled
-- and no policy, which denies every API role. Migration 10 adds the operator
-- policies. The pipeline connects as the table owner, which bypasses RLS.

create table issue (
  id uuid primary key default gen_random_uuid(),
  -- Assigned by `issue open` as max(number) + 1. The unique constraint makes
  -- two racing opens collide instead of cutting two issues with one number.
  number integer not null unique check (number > 0),
  title text not null default '' check (char_length(title) <= 200),
  intro text not null default '' check (char_length(intro) <= 4000),
  status text not null default 'draft' check (status in ('draft', 'published')),
  window_start timestamptz not null,
  window_end timestamptz not null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  check (window_end > window_start),
  -- A draft has not been published and a published issue has a timestamp, so
  -- "when did this go out" never needs a second source of truth.
  check ((status = 'draft') = (published_at is null))
);

-- `(true)` indexes the same constant for every draft row, so a second draft
-- collides with the first. Published issues are outside the index and may be
-- as many as there are weeks.
create unique index issue_one_draft_idx on issue ((true)) where status = 'draft';

create table issue_item (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references issue(id) on delete cascade,
  event_id uuid not null references change_event(id),
  -- Positions are not required to be contiguous: including an event later
  -- appends at max(position) + 1, and rendering orders by section, then position.
  position integer not null,
  section text not null check (section in ('lead', 'shipped', 'watch', 'voices')),
  -- Null or '' means un-annotated.
  note text check (char_length(note) <= 2000),
  -- Exclusion is a flag, not a delete, so excluding an item and bringing it
  -- back does not lose the sentence the operator wrote.
  included boolean not null default true,
  unique (issue_id, event_id),
  unique (issue_id, position)
);

-- Mirrors `delivery` from migration 2: one row per attempt per subscriber per
-- channel, with a partial unique index that makes "sent once" a database
-- guarantee, so publishing again can only retry what failed.
create table issue_delivery (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references issue(id) on delete cascade,
  subscriber_id uuid not null references subscriber(id) on delete cascade,
  channel text not null,
  status text not null check (status in ('sent', 'failed')),
  error text,
  attempted_at timestamptz not null default now()
);

create index issue_delivery_issue_subscriber_idx
  on issue_delivery (issue_id, subscriber_id, channel);
create unique index issue_delivery_sent_once_idx
  on issue_delivery (issue_id, subscriber_id, channel)
  where status = 'sent';

alter table issue enable row level security;
alter table issue_item enable row level security;
alter table issue_delivery enable row level security;

-- Supabase's default privileges hand `anon` (and `authenticated`) table
-- grants in public, so withdraw them explicitly instead of leaning on RLS
-- alone. `authenticated` does not exist on the local Docker Postgres, hence
-- the check.
revoke all on issue, issue_item, issue_delivery from anon;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on issue, issue_item, issue_delivery from authenticated;
  end if;
end
$$;
