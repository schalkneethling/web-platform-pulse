-- The anon role keeps only SELECT on the three tables it reads.
--
-- Supabase's default privileges hand `anon` every table privilege on a new
-- table in public. Migration 4 granted SELECT on these three tables and
-- enabled row-level security, but never withdrew the defaults, so production
-- was found (2026-11-21) with anon still holding TRUNCATE, REFERENCES and
-- TRIGGER on them.
--
-- TRUNCATE is the one that matters: row-level security does not apply to it,
-- so the policies are no protection. Nothing in PostgREST issues a TRUNCATE,
-- which is why this was not reachable from the browser, but "no known path"
-- is a weaker guarantee than "no privilege". The local Docker Postgres has no
-- such defaults, which is how the gap went unseen: the tests asserted what
-- anon could read, not everything it was allowed to do.
--
-- Revoke everything, then grant back the one privilege the reader needs, so
-- the end state does not depend on which defaults a project started with.
-- The policies from migrations 4 and 7 are untouched. `digest` is not listed
-- because migration 8 already did the same for it, with a column-level grant.

revoke all on change_event, event_source, digest_item from anon;
grant select on change_event, event_source, digest_item to anon;
