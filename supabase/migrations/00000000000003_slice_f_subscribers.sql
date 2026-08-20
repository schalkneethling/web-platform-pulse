-- Slice F.1 (§17): confirmation and unsubscribe state on subscriber, ahead
-- of public signup. Double opt-in — an open form that enrolls an address
-- before it's verified is a spam vector and a bounce risk for the sending
-- domain. Tokens are looked up directly (confirm/unsubscribe links), so
-- each gets its own unique index.

alter table subscriber
  add column confirmed_at timestamptz,
  add column unsubscribed_at timestamptz,
  add column confirm_token uuid not null default gen_random_uuid(),
  add column unsubscribe_token uuid not null default gen_random_uuid();

create unique index subscriber_confirm_token_idx on subscriber (confirm_token);
create unique index subscriber_unsubscribe_token_idx on subscriber (unsubscribe_token);
