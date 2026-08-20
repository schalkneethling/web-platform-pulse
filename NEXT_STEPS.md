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

The slices below are roughly in priority order. Slice G — the weekly
editorial issue — is the destination the others now serve: D keeps an issue
readable, F is what a curation surface is built on, and E is the polish that
can follow publication rather than precede it. So: D, F, G, then E.

---

## Slice D — Digest volume management

Chrome Platform Status alone can add several items on a busy day. Decide on
a per-theme cap with a "N more" fold in email and reader before the digest
bloats. The subscription `significance_floor` already provides a blunt
instrument; this slice is about presentation.

## Slice F — Reader SPA deployment and multi-subscriber

Parked until the digest is shared beyond the operator: replace the
`digestApi` Vite plugin with Supabase reads + RLS, deploy the SPA
(Cloudflare Pages or Vercel), and lift the single-email `ensureOperator`.

## Slice G — The weekly issue: curate, annotate, publish

The daily digest is a monitoring tool for the operator. The weekly issue is
the product: one editorial artifact, written once and sent to everyone, whose
value is the sentence a human adds to each item rather than the item itself.
The pipeline already finds and ranks everything; this slice is the layer
where a person decides what matters and says why.

**What already exists.** `subscription.cadence` accepts `'weekly'` and
`CADENCE_PERIOD_MS` in `src/store/store.ts` chains seven-day windows, covered
by `tests/integration/store.test.ts`. So a weekly _window_ is solved. What is
missing is issue _identity_ and _editorial intent_ — `digest` and
`digest_item` are per-subscriber machine output with a `position` and nothing
else, which is the wrong shape for something one person writes and many
people read.

**The shape.** A new pair of tables alongside `digest`, not replacing it:

- `issue` — `number`, `title`, `intro`, `status` (`draft` | `published`),
  `window_start`, `window_end`, `published_at`. Not per-subscriber: one row
  is one Monday morning email. `number` is `unique`, so a second `open` for
  the same week collides instead of cutting a rival draft.
- `issue_item` — `issue_id`, `event_id`, `position`, `section`, and `note`,
  the editorial annotation. Same constraint shape as `digest_item`:
  `issue_id references issue(id) on delete cascade`, `event_id references
change_event(id)`, and `unique (issue_id, event_id)` plus `unique
(issue_id, position)` so a re-run of `open` can't double-insert an item or
  leave two items fighting over one slot. The `note` is the whole point; an
  issue whose items are all un-annotated is a changelog and should read as a
  warning.

`change_event` stays untouched — curation is a selection over it, never a
mutation of it, so a re-run of the pipeline can never disturb a draft.

**The curation surface.** Extend the reader SPA (`src/reader/`) with an
operator view over the open window: the week's `change_event` rows sorted by
`significance`, each with include/exclude and a note field. This is the piece
that makes Slice F a prerequisite rather than a nice-to-have — the view needs
real Supabase reads and an authenticated operator, not the `digestApi` Vite
plugin. Curating from the daily _emails_ is the thing to avoid: it re-does
selection work against a lossy copy of the database.

**The commands.** Extend `src/cli/index.ts` (`vp run pulse`) with issue
subcommands rather than a second binary:

- `open` — cut a draft `issue` for the elapsed week and pre-fill `issue_item`
  from the top-ranked events, as a starting point to edit down.
- `preview` — render the draft through the email template to Mailpit, so the
  Sunday read-through happens in the real artifact.
- `publish` — flip `status`, stamp `published_at`, and fan out to confirmed
  subscribers. Idempotent the same way the daily send is: a `delivery`-shaped
  record per (issue, subscriber, channel) written before the provider call,
  with a partial unique index on the sent rows, so publishing twice — or
  resuming after a crash mid-fan-out — sends once and only retries what
  failed.

**Deliberately deferred.** Per-subscriber filtering (`taxonomies`,
`significance_floor`) does not apply to the issue — it is one hand-written
artifact, and filtering it per reader would gut the editorial voice. Those
settings stay meaningful for the daily digest only.

**The bar for done.** A skip week is survivable; silence is not. `open`
should be cheap enough to run every week even when the honest output is a
short issue.

---

## Slice E — Richer taxonomy (group-graph walk)

Replace the spec-URL heuristic in `src/core/web-features/diff.ts` with a
taxonomy derived from the web-features group graph; browser-specs group
data can serve the other adapters. Gets more valuable with every source
added — it is what keeps a fatter digest well grouped.

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
