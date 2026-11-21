-- Slice F.8 (§17): public signup. The reader is a static bundle that holds
-- only the public anon key, and migration 4 gave anon no access to
-- `subscriber` -- correctly, since that table holds addresses and tokens. So
-- the write path cannot be an INSERT from the browser. It is a function the
-- anon role may execute through PostgREST's RPC endpoint, which does exactly
-- one thing: queue a double opt-in. The confirmation email itself is sent by
-- the Node pipeline (src/cli/confirmations.ts), which already owns SMTP; this
-- migration only records that one is owed.

-- When the confirmation email was last sent, and how many times. A row with
-- no confirmation_sent_at, no confirmed_at and no unsubscribed_at is waiting
-- for the pipeline to send it. The attempt count caps how often a stranger
-- can make us email the same address.
alter table subscriber
  add column confirmation_sent_at timestamptz,
  add column confirmation_attempts integer not null default 0;

-- subscriber_email_key (migration 1) is case-sensitive, so "A@x.com" and
-- "a@x.com" would be two subscribers. The function stores the lower-cased
-- address; this index makes the database refuse a case-variant duplicate even
-- if a future writer forgets to.
create unique index subscriber_email_lower_idx on subscriber (lower(email));

-- The write path. `security definer` runs it with its owner's privileges, so
-- it can touch `subscriber` although the caller cannot. That makes it the
-- one place where anon input crosses into a trusted table, so:
--   * `set search_path = ''` stops a caller shadowing a table or operator
--     with an object of their own in a schema they control; every table is
--     schema-qualified for the same reason.
--   * The address is the only input, and it is validated before it is used.
--
-- It returns void in every valid-email case, whatever it did. A response that
-- differed between "new", "already confirmed" and "already pending" would let
-- anyone probe the list for a given address. The browser learns only that the
-- request was accepted; the person at that address learns the rest by email.
--
-- An invalid address raises errcode 22023 (invalid_parameter_value), which
-- PostgREST reports as HTTP 400. That reveals nothing about the list.
create function request_subscription(requested_email text)
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
     or normalised !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid email address' using errcode = '22023';
  end if;

  -- `for update` serialises two simultaneous requests for one address.
  select * into existing from public.subscriber where lower(email) = normalised for update;

  if not found then
    -- Same shape as ensureOperator, minus the auto-confirmation: confirmed_at
    -- stays null until the person follows the link. `do nothing` covers the
    -- narrow race where another request inserted the address after the select.
    insert into public.subscriber (email) values (normalised)
      on conflict do nothing
      returning id into inserted_id;
    if inserted_id is not null then
      insert into public.subscription (subscriber_id) values (inserted_id);
    end if;
    return;
  end if;

  if existing.unsubscribed_at is not null then
    -- They left and are asking back in. Treat it as a new signup: the old
    -- confirmation no longer counts, and the old token was in an email that
    -- may sit in someone else's inbox now, so rotate it.
    update public.subscriber
      set unsubscribed_at = null,
          confirmed_at = null,
          confirm_token = gen_random_uuid(),
          confirmation_sent_at = null,
          confirmation_attempts = 0
      where id = existing.id;
  elsif existing.confirmed_at is not null then
    -- Already subscribed: do nothing at all. In particular, never reset
    -- confirmed_at, or a stranger could un-confirm somebody by typing their
    -- address into the form.
    null;
  elsif existing.confirmation_sent_at is not null
        and existing.confirmation_sent_at < now() - interval '1 day'
        and existing.confirmation_attempts < 3 then
    -- Unconfirmed, and the last email is a day old: a lost message is worth
    -- one more try. Three sends is the ceiling, so a form that is hammered
    -- with one address cannot turn into a mail bomb.
    update public.subscriber set confirmation_sent_at = null where id = existing.id;
  end if;
end;
$$;

-- Migration 4 revoked EXECUTE from PUBLIC on every function that existed,
-- but a function created afterwards gets the default PUBLIC grant again, so
-- withdraw it here first. The grant to anon that follows is the one
-- deliberate exception to migration 4's "anon can call nothing": the browser
-- has to reach this function, and this function alone.
revoke execute on function request_subscription(text) from public;
grant execute on function request_subscription(text) to anon;
