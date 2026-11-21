# Next Steps

The prototype is proven: the pipeline runs daily in GitHub Actions against
Supabase and Resend, and the digest arrives by email. Nine sources feed it —
web-features Baseline transitions, browser releases (Chrome, Firefox, Safari,
all channels), runtime releases (Node.js, Deno, Bun), Mozilla and WebKit
standards positions, Chrome Platform Status feature transitions, W3C spec
lifecycle transitions, W3C TAG design reviews, and first-party blog voices.

Earlier slices now shipped: subscription filtering (taxonomies +
significance floor), cadence-window batching, the browser-release and
runtime-release adapters, the richer email template, W3C spec-transition
tracking with editor/working-group attribution, TAG design-review tracking
with `Resolution:` verdicts (Slice B), and the "Voices" digest section
aggregating the WebKit, Igalia, Mozilla Hacks, W3C, and WHATWG blogs
(Slice C). Chromium blog and web.dev remain easy Voices additions.

The slices below were in priority order. Slice G — the weekly editorial
issue — is the destination the others serve: D keeps an issue readable, F is
what a curation surface is built on, and E is the polish that follows
publication. D, E, F and G are done, so the roadmap has no remaining slice.
What is left is the "deliberately leaves out" list at the end of each slice
below, which is now the backlog.

---

## Slice D — Digest volume management

Chrome Platform Status alone can add several items on a busy day. Decide on
a per-theme cap with a "N more" fold in email and reader before the digest
bloats. The subscription `significance_floor` already provides a blunt
instrument; this slice is about presentation.

## Slice F — Reader SPA deployment and multi-subscriber

Done, in two halves.

The deployment half: the `digestApi` Vite plugin is gone, the reader reads
through PostgREST with the anon key, every table carries RLS, and the SPA
deploys to Cloudflare Workers static assets on each push to `main`.
Cloudflare now steers new static projects to Workers rather than Pages, so
that is where it went.

The multi-subscriber half: a visitor signs up through a form in the reader,
confirms through an emailed link, and from then on receives their own
filtered digest; every digest email carries an unsubscribe link. One pipeline
run serves every confirmed subscriber, and a new subscriber's first digest
starts at their confirmation rather than at the beginning of the archive.
The operator is an explicit `is_operator` flag instead of "whoever was
created first", and the read policies let the anon role see the operator's
digest only.

What Slice F deliberately leaves out:

- **A per-subscriber reader view.** Other subscribers get their digest by
  email and have no page of their own. Showing them one needs real
  authentication (Supabase Auth, `auth.uid()` predicates on `digest`).
  Slice G added that authentication for the operator only, so the view is
  still to build.
- **A subscription settings page.** `taxonomies`, `significance_floor` and
  `cadence` exist per subscriber, but only SQL can change them today. The
  same authentication unlocks it.
- **Bot protection on the signup form.** The database and the sender bound
  the damage (one confirmation per address per day and three in total, twenty
  per run, two hundred per day, unconfirmed rows deleted after a week), but a
  script can still spend that daily allowance on strangers' addresses and
  crowd out real signups. Cloudflare
  Turnstile needs a server to verify the token, which means giving the Worker
  a script; do that before the form gets real traffic.
- **Function privileges depend on the Supabase project's defaults.** Checked
  against production when migrations 4 to 8 were applied (2026-11-21): this
  project does not hand `anon` or `authenticated` execute on new functions
  in `public`, so the four that `anon` can call are callable only through
  their explicit grants. Older Supabase projects grant it by default, and
  the local database cannot show the difference, so re-check with
  `has_function_privilege` after adding a `security definer` helper.
- **One-click unsubscribe (RFC 8058).** Mail clients POST to the unsubscribe
  URL without the `apikey` header PostgREST requires, so the header points at
  the reader's page instead. The same Worker script would fix it.

## Slice G — The weekly issue: curate, annotate, publish

Done. The daily digest is a monitoring tool for the operator; the weekly issue
is the product: one editorial artifact, written once and sent to everyone,
whose value is the sentence a human adds to each item rather than the item
itself.

A new pair of tables, `issue` and `issue_item`, sits beside `digest` instead
of replacing it, and `change_event` is never written by any of it, so a
pipeline re-run cannot disturb a draft. Four commands run the week:
`vp run pulse issue open` cuts the draft for the elapsed week (or reports the
open one) and pre-fills it with the top twelve events; `issue preview` mails
the draft, marked as a preview, to the operator; `issue publish` flips the
status and mails every confirmed subscriber once (it refuses a draft with no
title); `issue retry` resends the emails that failed, for any published issue,
and publishes nothing. `.github/workflows/issue.yml` runs `open` every Sunday
at 06:00 UTC and offers all four by hand. Curation happens at `/curate` in the reader: the
operator signs in with Google (Supabase Auth), and the database decides who
that is (`is_operator_request()`, migration 10, by the token's `sub` against the
`auth_user_id` that `operator link` stored), so the page holds no access rule of
its own. An issue with no note on any included item is flagged on the
console by `open` and `publish`, and by a banner in the preview email.

What Slice G deliberately leaves out:

- **Reordering items within a section.** Items render by section, then
  `position`. Including an event appends it at the end of the positions, and
  nothing in the page or the functions moves one.
- **A public archive of published issues.** `anon` has no grant on the issue
  tables, so a published issue exists only in subscribers' inboxes and to the
  operator's session.
- **Publishing from the browser.** `preview` and `publish` are commands only.
  The page edits a draft and does not send mail.
- **A per-subscriber reader view and a settings page.** The same Google sign-in
  now makes both possible, but the `authenticated` role has policies only for
  the operator's curation tables, so a subscriber who signs in sees nothing.
  Both still need `auth.uid()` predicates and a mapping from an auth user to a
  `subscriber` row.
- **Exactly-once delivery when a run dies mid-send.** Each email is sent
  before its `issue_delivery` row is written, so a crash between the provider
  accepting a message and the row being written mails that subscriber again on
  the next run. The other order would turn the same crash into a subscriber
  who never receives the issue.
- **Signing in on a local machine.** The local stack is Postgres and PostgREST
  with no Supabase Auth server, so "Sign in with Google" works only against a
  real project. The browser tests sign in by storing a session minted with the
  local secret.
- **Re-sorting the list while it is being edited.** The page orders events
  once, when it loads (included first), and an event keeps its place when it is
  included or excluded, so keyboard focus does not move under the operator.
  The next load shows the included events first.

---

## Slice E — Richer taxonomy (group-graph walk)

Done. A web-features event's taxonomy now comes from the group graph that
the `web-features` artifact already carries as its top-level `groups` object,
so no new dependency and no second download were needed. Each of a feature's
groups is walked up its `parent` links to a root; the roots `css`, `html` and
`javascript` become those themes, and any other root (`webgl`, `scrolling`,
`canvas`, …) contributes nothing. A feature in groups under several of those
three roots gets several themes, in digest order, and the digest groups it under
the first. A feature with no theme from its groups falls back to the old
spec-URL guess, and to `api` only when that has no answer either, so no feature
has an empty taxonomy.
The logic lives in `src/core/taxonomy.ts`.

Chrome Platform Status now uses the same mapping for the features Chromium has
tied to a web-features id; the rest keep their chromestatus-category theme. The
pipeline fetches the web-features data once per run and shares it between the
two sources, and if that download fails, Chrome Platform Status still runs on
categories.

Existing `change_event.taxonomy` values are not backfilled. Taxonomy is written
when an event is ingested, so every event from before this change keeps the
theme the spec-URL guess gave it, and an old event for a feature can sit under
a different theme from a new event for the same feature. Backfilling would mean
re-deriving each stored event's taxonomy from its subject, which only works for
events whose subject is a web-features id; decide that when the mismatch shows
up in a digest or an issue worth fixing.

A change in a feature's taxonomy alone never produces an event: the web-features
differ compares baseline and support only, and the stored cursor is the derived
index, so the first run after this change quietly rewrites every feature's
taxonomy in the cursor.

What Slice E deliberately leaves out:

- **Themes for other roots.** Only `css`, `html` and `javascript` roots give a
  theme, so a feature whose groups are all under another root (`webgl`,
  `canvas`, …) is classified by its spec URL or lands in `api`. Giving a root a
  theme of its own (the AI-standards coverage plan proposes an `ai` theme) means
  adding it to the root-to-theme table in `src/core/taxonomy.ts`.
- **Sharing the mapping with the other adapters.** `w3c-specs`,
  `standards-positions`, `tag-reviews`, `voices`, `browser-releases` and
  `runtime-releases` still set their own taxonomy; none of them carries a
  web-features id to look up.

## Researched and rejected (2026-07)

So these don't get re-litigated: **TC39 proposals** (markdown only, no
stable IDs or machine-readable stages), **CSSWG resolutions** (live only in
issue comments; would need comment crawling at scale), **WHATWG sg/db.json**
(static org metadata, no events), **Interop 2026** (no published score
artifact; the dashboard is a rendered SPA).

## Standing notes

- **Sending domain**: the Resend sandbox address is fine for the operator;
  verify a real domain before sharing the digest with anyone else.
- **Production scheduling**: GitHub Actions cron is adequate for now;
  Supabase pg_cron or a Cloudflare Worker remain the exit paths if Actions
  becomes limiting.
