-- Slice F.9 (§17): the two links in a subscriber's email. The confirmation
-- email carries confirm_token and every digest carries unsubscribe_token (both
-- from migration 3). Like request_subscription in migration 5, each is a
-- function anon may execute, because anon has no access to `subscriber` and
-- the reader is a static bundle that holds only the anon key.
--
-- The token is the only credential, and it is a uuid: a random 122-bit value
-- that cannot be guessed. Taking a `uuid` parameter also means PostgREST
-- rejects a malformed token with a 400 before either function runs. The
-- parameters are named `presented_token` so that inside the function bodies
-- they cannot be mistaken for the `confirm_token` and `unsubscribe_token`
-- columns (the same reason migration 5 calls its parameter `requested_email`).
--
-- Both return a boolean, and unlike request_subscription that is safe to
-- reveal: a caller already holds a token, so "the token is valid" tells them
-- nothing about anyone else on the list. The page needs it to tell success
-- apart from a dead link instead of showing success either way.

-- Confirm a subscription. It stamps confirmed_at only while that is null, so a
-- second visit (a mail client prefetching the link, a person clicking twice)
-- is a harmless no-op that writes no second timestamp and still returns true.
--
-- A row that has unsubscribed never confirms. Re-subscribing through
-- request_subscription rotates confirm_token, so an old link in an old email
-- would not match anyway; the unsubscribed_at test additionally covers an
-- unsubscribed row whose token has not been rotated yet, so a stale link can
-- never revive a subscription.
create function confirm_subscription(presented_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.subscriber
    set confirmed_at = now()
    where confirm_token = presented_token
      and unsubscribed_at is null
      and confirmed_at is null;
  if found then
    return true;
  end if;

  -- Nothing was stamped. That is a success only if the row exists and is
  -- already confirmed; otherwise the token is unknown or the row has left.
  return exists (
    select 1 from public.subscriber
    where confirm_token = presented_token and unsubscribed_at is null
  );
end;
$$;

-- Unsubscribe. It stamps unsubscribed_at only while that is null, so repeating
-- the link keeps the first timestamp. unsubscribe_token is deliberately not
-- rotated: every digest ever sent carries it, and an old email must keep
-- working as a way out. (A re-subscribe rotates confirm_token only.)
create function unsubscribe(presented_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.subscriber
    set unsubscribed_at = now()
    where unsubscribe_token = presented_token
      and unsubscribed_at is null;
  if found then
    return true;
  end if;

  return exists (
    select 1 from public.subscriber where unsubscribe_token = presented_token
  );
end;
$$;

-- A function created after migration 4 gets the default PUBLIC grant, so
-- withdraw it, then grant anon alone: these two, with request_subscription,
-- are the only public functions the browser may call.
revoke execute on function confirm_subscription(uuid) from public;
grant execute on function confirm_subscription(uuid) to anon;
revoke execute on function unsubscribe(uuid) from public;
grant execute on function unsubscribe(uuid) to anon;
