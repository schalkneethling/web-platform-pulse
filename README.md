# Web Platform Pulse

A daily digest of what changed across the web platform — Baseline transitions,
browser support changes, and browser releases on every channel — delivered by
email and rendered in a small reader app.

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
vp run pulse -- --data tests/fixtures/web-features/old.json   # seed the cursor
vp run pulse -- --data tests/fixtures/web-features/new.json   # emit a digest
vp dev                     # reader at http://localhost:5173
```

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
| `--email` / `PULSE_SUBSCRIBER_EMAIL` | The subscriber address                                      |
| `--smtp` / `PULSE_SMTP_URL`          | SMTP transport; omit it and email is skipped                |
| `PULSE_EMAIL_FROM`                   | Sender address                                              |
| `DATABASE_URL`                       | Postgres connection (defaults to the local Docker instance) |

## Testing

```sh
vp check          # format, lint, type check
vp test           # unit + integration (starts Postgres and Mailpit in Docker)
vp run test:e2e   # Playwright against the seeded reader
```

Integration tests deliver real email into [Mailpit](https://mailpit.axllent.org)
(`smtp://localhost:54330`, UI on `http://localhost:54331`) and assert on its API.

## Deployment (prototype)

The prototype runs on free tiers end to end — see `NEXT_STEPS.md` for the full
walkthrough and what comes next.

- **Supabase** hosts Postgres; apply `supabase/migrations/` in the SQL editor.
- **Resend** provides SMTP: `smtps://resend:API_KEY@smtp.resend.com:465` (the
  `smtps://` scheme matters — port 465 expects TLS from the first byte).
- **GitHub Actions** (`.github/workflows/pulse.yml`) runs the pipeline daily at
  07:00 UTC, with `workflow_dispatch` for manual runs.

Repository secrets: `DATABASE_URL`, `PULSE_SMTP_URL`, `PULSE_SUBSCRIBER_EMAIL`,
`PULSE_EMAIL_FROM`.

## Project layout

```
src/
  adapters/        one module per source: fetch + parse into candidate events
  core/            pure domain logic: event types, diffs, significance, digest order
  store/           PostgreSQL persistence: ingest, digest assembly, delivery records
  delivery/        channels (email) and transports (SMTP)
  cli/             the pipeline and its prototype trigger
  reader/          React app rendering the latest digest
supabase/          migrations (Supabase-compatible SQL)
tests/             integration tests and shared fixtures
e2e/               Playwright tests against the seeded reader
```

## License

[MIT](LICENSE)
