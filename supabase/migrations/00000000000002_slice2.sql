-- Slice 2 (§16): delivery records. One row per attempt per channel (§10);
-- the partial unique index makes "sent once" a database guarantee, so a
-- re-run can only resend what failed.

create table delivery (
  id uuid primary key default gen_random_uuid(),
  digest_id uuid not null references digest(id) on delete cascade,
  channel text not null,
  status text not null check (status in ('sent', 'failed')),
  error text,
  attempted_at timestamptz not null default now()
);

create index delivery_digest_channel_idx on delivery (digest_id, channel);
create unique index delivery_sent_once_idx on delivery (digest_id, channel)
  where status = 'sent';
