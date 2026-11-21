# Web Platform Pulse

A daily digest of what changed across the web platform — Baseline transitions,
browser support changes, browser releases on every channel, standards signals,
and first-party commentary — delivered by email and rendered in a small reader
app.

## What it watches

| Source                                                                 | What it observes                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [web-features](https://github.com/web-platform-dx/web-features)        | Features reaching Baseline (newly/widely available) and per-browser support changes                    |
| Chromium Dash                                                          | Chrome releases: Stable, Beta, Dev, Canary                                                             |
| Mozilla product-details                                                | Firefox releases: stable, Beta, Nightly                                                                |
| Apple developer releases RSS                                           | Safari releases: stable, beta, Technology Preview                                                      |
| nodejs.org dist index, GitHub releases                                 | Runtime releases: Node.js (Current and LTS), Deno, Bun                                                 |
| Mozilla & WebKit standards-positions                                   | Vendor positions on proposals: taken, revised, or first published                                      |
| [Chrome Platform Status](https://chromestatus.com)                     | Chrome feature status: shipped, origin trial, behind a flag, deprecated, removed                       |
| [w3c/browser-specs](https://github.com/w3c/browser-specs) + api.w3.org | W3C spec lifecycle transitions (FPWD, CR, Recommendation, …) with editor and working-group attribution |
| [w3ctag/design-reviews](https://github.com/w3ctag/design-reviews)      | TAG design reviews opening and closing, with the `Resolution:` verdict (satisfied, unsatisfied, …)     |
| WebKit, Igalia, Mozilla Hacks, W3C, and WHATWG blogs                   | First-party commentary, rendered as the digest's own "Voices" section                                  |

## How it works

One idempotent pipeline run does everything:

```
adapters ──▶ candidate events ──▶ correlation & de-duplication ──▶ digest assembly ──▶ delivery
(diff feeds     (what changed,       (one real-world change =        (grouped by theme,     (email; the
 against a       with provenance      one change_event row;           ranked by             persisted digest
 saved cursor)   links)               re-runs write nothing)          significance)          is the reader's)
```

- **Adapters** fetch a source's published artifact, diff it against a cursor
  saved from the previous run, and emit candidate events. A failing source is
  skipped and retried from its cursor next run; it never blocks the others.
- **Correlation** turns observations into canonical `change_event` rows: a
  candidate matching an existing event by correlation key attaches its
  provenance instead of creating a duplicate.
- **Significance** is a transparent heuristic in one pure function
  (`src/core/significance.ts`): Baseline widely available scores highest;
  pre-release browser churn (Canary, Nightly) scores lowest.
- **Delivery** is channel-based and exactly-once per digest per channel — a
  partial unique index makes "sent once" a database guarantee, so re-runs only
  resend what failed.

Every digest item links back to the sources that observed it.

## Getting started

Requirements: [Bun](https://bun.sh) (pinned via `packageManager`), Docker (for
the local database and mail catcher), and the [Vite+](https://viteplus.dev)
toolchain the project is built on (`vp` comes with the dependencies).

```sh
vp install                 # install dependencies
vp run db:up               # disposable Postgres in Docker, migrations applied
APP_ENV=test vp run pulse -- --data tests/fixtures/web-features/old.json   # seed the cursor
APP_ENV=test vp run pulse -- --data tests/fixtures/web-features/new.json   # emit a digest
vp run dev:reader          # reader at http://localhost:5173
```

Configuration comes from [Varlock](https://varlock.dev): `.env.schema` names
every variable, and each value is a reference into the 1Password item
`web-platform-pulse` in the `dev` vault, one field per variable. There are no
`.env` files to fill in. `APP_ENV=test` swaps the whole item for the
committed `.env.test` -- the local Docker services and placeholders -- which
is what the commands above, `vp test`, Playwright, and CI run under. Anything
else (`vp run pulse` against live sources, `vp dev`) resolves through the
[1Password CLI](https://developer.1password.com/docs/cli/) and the desktop
app's CLI integration, so both need to be installed and enabled.

The reader reads through PostgREST with an anon key rather than through the
dev server, so `vp run dev:reader` is the entry point: it brings up a local
PostgREST over the same Postgres and passes `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` to `vp dev`. Plain `vp dev` still serves the app,
but without those two the page can only render its error state.

The pipeline CLI (`vp run pulse`) pulls live data when run without flags.
Useful flags and environment variables:

| Flag / env                           | Purpose                                                     |
| ------------------------------------ | ----------------------------------------------------------- |
| `--data <path>`                      | Web-features fixture instead of the live artifact           |
| `--releases <path>`                  | Browser-release fixture instead of the live feeds           |
| `--runtimes <path>`                  | Runtime-release fixture instead of the live feeds           |
| `--positions <path>`                 | Standards-positions fixture instead of the live feeds       |
| `--chrome <path>`                    | Chrome Platform Status fixture instead of the live feed     |
| `--specs <path>`                     | W3C spec-transition fixture instead of the live feeds       |
| `--tag-reviews <path>`               | TAG design-review fixture instead of the live issues API    |
| `--voices <path>`                    | Voices fixture instead of the live blog feeds               |
| `--email` / `PULSE_SUBSCRIBER_EMAIL` | The operator's address; changing it re-points the reader    |
| `--smtp` / `PULSE_SMTP_URL`          | SMTP transport; omit it and email is skipped                |
| `PULSE_EMAIL_FROM`                   | Sender address                                              |
| `PULSE_PUBLIC_URL`                   | The reader's origin; confirm and unsubscribe links use it   |
| `DATABASE_URL`                       | Postgres connection (defaults to the local Docker instance) |

Every variable in the table is an item in `.env.schema`; setting it in the
shell overrides what Varlock resolves.

`vp run pulse confirmations` sends only the pending signup confirmation
emails and exits. A plain `vp run pulse` sends them too, after the pipeline.

## Subscribers

There are two kinds of subscriber. The **operator** is the address in
`PULSE_SUBSCRIBER_EMAIL`: the pipeline creates it, confirms it without an
email round trip, and marks it with `subscriber.is_operator`. Its digest is
unfiltered, and it is the one the public reader shows.

Everyone else signs up through the form in the reader and goes through double
opt-in:

```
reader form ──► request_subscription()      unconfirmed row
                        │
pulse confirmations ──► email with /confirm?token=…
                        │
/confirm page, button ──► confirm_subscription()   confirmed_at set
                        │
daily pulse run ──► their own filtered digest, by email only
                        │
/unsubscribe page, button ──► unsubscribe()        unsubscribed_at set
```

The three functions are `security definer` SQL functions (migrations 5 and 6)
that the browser calls through PostgREST as the `anon` role, because that
role has no access to the `subscriber` table itself. A new subscriber's first
digest covers only what was observed after they confirmed; they are never
sent the backlog.

The form is public, so the database and the sender bound what it can cost:
one confirmation email per address per day and three in total, twenty per
run, two hundred per day, and a signup nobody confirms is deleted after seven
days. A digest that fails to deliver is retried on five runs and then left.

## The weekly issue

The daily digest is the operator's monitoring tool. The weekly issue is one
email, written by hand, that every confirmed subscriber receives once:

```
issue open     Sunday 06:00 UTC (issue.yml) or by hand: a draft, pre-filled with
     │         the week's twelve top-ranked events
/curate        in the reader: title, intro, which events, their section, a note on each
     │
issue preview  the draft mailed to the operator, subject marked [Preview]
     │
issue publish  status becomes published, every confirmed subscriber is mailed once
     │
issue retry    any send that failed is sent again, for every published issue
```

The four commands are `vp run pulse issue open`, `issue preview`,
`issue publish` and `issue retry`. `open` needs only the database; if a draft
already exists it changes nothing. `preview` needs `PULSE_SMTP_URL`,
`PULSE_PUBLIC_URL` and the operator's address (`PULSE_SUBSCRIBER_EMAIL` or
`--email`), and writes nothing.

`publish` needs the first two settings and a draft. It refuses, and leaves the
draft a draft, unless the draft has a title and at least one included item or an
intro. `issue open` pre-fills a draft with a blank title, so a draft nobody has
edited can never be published by mistake. With no draft it exits 1 and points at
`issue retry`. After publishing it sends every email still owed for every
published issue, oldest issue first.

`retry` needs the same settings and publishes nothing, so it is safe to run
while next week's draft is open. It sends the emails that failed, for the newest
issue or an older one. Neither command sends anything twice: a subscriber with a
`sent` row is never selected again, and a subscriber is retried until five sends
have failed. A run that has a failed send exits 1.

Only one `publish` or `retry` runs at a time. Each takes a Postgres advisory
lock for the whole run, and a run that cannot get it prints that another is
already running, sends nothing and exits 1. The lock lives as long as one
database connection, so `DATABASE_URL` must be a direct connection or Supabase's
Session pooler, not the Transaction pooler.

`.github/workflows/issue.yml` runs `open` every Sunday at 06:00 UTC, which sends
no mail, and lets you run `open`, `preview`, `publish` or `retry` from the
Actions tab. Publishing is never scheduled, because the issue is worth what the
operator writes on each item.

### Curating at `/curate`

Open `/curate` on the reader and press "Sign in with Google". The reader asks
the database whether that account is the operator: the Google address must
match the subscriber marked `is_operator` (the address in
`PULSE_SUBSCRIBER_EMAIL`), and Supabase must report `google` as the sign-in
provider. Any other account sees "This account is not the operator" and can
read and write nothing, whatever the browser does, because the check lives in
migration 10 and not in the page.

The page lists the draft's window, included events first. Each event has an
Include checkbox and, once included, a section and a note. Changes save as you
make them: the checkbox and the section on change, the note, title and intro
when the field loses focus and its text has changed. Each item says "Saved." or
why it was not saved, and keeps what you typed when a save fails. The page
shows the first 50 events that are not in the issue and a "Show 50 more"
button for the rest.

The public pages (`/`, `/confirm`, `/unsubscribe`) use a separate Supabase
client that never holds a session, so they send the anon key and look the same
to everyone, including an operator who is signed in. Only `/curate` keeps a
session.

Locally there is no Supabase Auth server (only Postgres and PostgREST), so the
sign-in button works only against a real Supabase project. The browser tests
sign in by storing a session minted with the local secret.

### One-time production setup

1. In the Supabase dashboard, enable the Google provider under Authentication
   and give it a Google OAuth client. Google's authorised redirect URI is the
   project's `https://<project-ref>.supabase.co/auth/v1/callback`.
2. Under Authentication, URL Configuration, add the reader's origin and its
   `/curate` page (`https://<reader origin>/curate`) to the allowed redirect
   URLs. Without this, Supabase sends the operator back to the Site URL.
3. Apply migrations 9 and 10 in the SQL editor, in order, before merging the
   code that uses them, as with every migration.
4. Turn off email-and-password sign-ups under Authentication. Only a Google
   sign-in can curate, because the database requires `google` among the
   token's providers, so a password account adds nothing but an account to
   look after, and an account registered with the operator's address is one
   Supabase could later link to the operator's Google identity.

## Testing

```sh
vp check          # format, lint, type check
vp test           # unit + integration (starts Postgres and Mailpit in Docker)
vp run test:e2e   # Playwright against the seeded reader
```

Integration tests deliver real email into [Mailpit](https://mailpit.axllent.org)
(`smtp://localhost:54330`, UI on `http://localhost:54331`) and assert on its API.

The e2e run adds a PostgREST container (`http://localhost:54332`) so the
browser exercises the same client, the same anon role and the same
row-level-security policies the deployed reader will. It also starts Mailpit,
because the curation spec previews and publishes an issue through the real
mail sender. That spec and the PostgREST curation spec share the single draft
the database allows, so `playwright.config.ts` runs them one after the other.

## Deployment (prototype)

The prototype runs on free tiers end to end — see `NEXT_STEPS.md` for the full
walkthrough and what comes next.

- **Supabase** hosts Postgres; apply `supabase/migrations/` in the SQL editor.
- **Resend** provides SMTP: `smtps://resend:API_KEY@smtp.resend.com:465` (the
  `smtps://` scheme matters — port 465 expects TLS from the first byte).
- **GitHub Actions** (`.github/workflows/pulse.yml`) runs the pipeline daily at
  07:00 UTC, with `workflow_dispatch` for manual runs. A second workflow
  (`confirmations.yml`) sends pending signup confirmations every 15 minutes.
- **Cloudflare Workers** hosts the reader as static assets (`wrangler.jsonc`),
  deployed by `.github/workflows/deploy.yml` on every push to `main`.

1Password is used on the development machine only. The workflows read
GitHub's own repository secrets -- `DATABASE_URL`, `PULSE_SMTP_URL`,
`PULSE_PUBLIC_URL`, `PULSE_SUBSCRIBER_EMAIL`, `PULSE_EMAIL_FROM`, `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` --
and one command copies them there from the `web-platform-pulse` item:

```sh
vp run secrets:push --dry-run   # list what would be pushed
vp run secrets:push             # resolve from 1Password, push with `gh secret set`
```

Rotating a value means editing the item and running that command again. No
1Password credential lives outside the laptop, so there is no service account.

The two `VITE_` values are compiled into the bundle and are public by design:
the anon key selects a Postgres role, and `supabase/migrations/` is what
decides what that role may read. The Cloudflare API token needs only the
"Edit Cloudflare Workers" permission.

The reader shows the operator's most recent digest to anyone who visits, and
only that one: migration 7 restricts the `anon` role to the operator's digest
rows, so another subscriber's filtered digest is not readable through the
public key.

Apply every migration before the code that depends on it is merged. The
pipeline reads columns that migrations 5 to 8 add, so a deploy ahead of the
SQL editor fails the daily run.

## Project layout

```
src/
  adapters/        one module per source: fetch + parse into candidate events
  core/            pure domain logic: event types, diffs, significance, digest order
  store/           PostgreSQL persistence: ingest, digest assembly, delivery records
  delivery/        channels (email) and transports (SMTP)
  cli/             the pipeline and its prototype trigger
  reader/          React app: the latest digest, signup, and the operator's /curate page
supabase/          migrations (Supabase-compatible SQL)
tests/             integration tests and shared fixtures
e2e/               Playwright tests against the seeded reader
```

## License

[MIT](LICENSE)
