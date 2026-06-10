-- Slice 1 (§16): the minimum canonical store the first vertical slice needs.
-- The schema grows by use; later slices add tables and columns as they need
-- them. Row-level-security policies arrive with the Supabase stack, since
-- they reference auth.uid().

create extension if not exists pgcrypto;

create table subscriber (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text,
  created_at timestamptz not null default now()
);

create table subscription (
  id uuid primary key default gen_random_uuid(),
  subscriber_id uuid not null references subscriber(id) on delete cascade,
  cadence text not null default 'daily',
  taxonomies text[],
  significance_floor real not null default 0,
  created_at timestamptz not null default now()
);

create table source (
  id text primary key,
  kind text not null,
  config jsonb not null default '{}'::jsonb
);

create table source_state (
  source_id text primary key references source(id) on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

create table change_event (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  subject jsonb not null,
  title text not null,
  before jsonb,
  after jsonb not null,
  occurred_at text,
  first_observed_at timestamptz not null default now(),
  last_updated_at timestamptz not null default now(),
  significance real not null,
  taxonomy text[] not null default '{}',
  dedupe_key text not null unique,
  correlation_key text not null
);

create index change_event_correlation_key_idx on change_event (correlation_key);
create index change_event_first_observed_idx on change_event (first_observed_at);

create table event_source (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references change_event(id) on delete cascade,
  source_id text not null references source(id),
  url text not null,
  title text not null,
  observed_at timestamptz not null,
  raw_ref text,
  unique (event_id, source_id, url)
);

create table digest (
  id uuid primary key default gen_random_uuid(),
  subscriber_id uuid not null references subscriber(id) on delete cascade,
  cadence text not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  created_at timestamptz not null default now()
);

create table digest_item (
  id uuid primary key default gen_random_uuid(),
  digest_id uuid not null references digest(id) on delete cascade,
  event_id uuid not null references change_event(id),
  position integer not null,
  unique (digest_id, position),
  unique (digest_id, event_id)
);
