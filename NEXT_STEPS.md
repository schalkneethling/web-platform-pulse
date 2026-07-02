# Next Steps

Two slices are complete. The pipeline runs end-to-end locally: a Baseline change
in `web-features` flows through correlation, digest assembly, and an email
delivery that the database guarantees is sent exactly once.

---

## Prototype deployment (do this first)

Prove the pipeline works in production before building anything else. The goal is
email delivery to your inbox on a daily schedule. No code changes are required —
`connect()` already reads `DATABASE_URL` and the CLI already reads
`PULSE_SMTP_URL` and `PULSE_SUBSCRIBER_EMAIL` from the environment.

### Stack

| Concern | Service | Cost |
|---|---|---|
| Postgres | Supabase free tier | Free |
| Email transport | Resend free tier | Free (3k/month) |
| Scheduler | GitHub Actions cron | Free |
| Reader SPA | Defer — email is the proof | — |

### Step 1 — Supabase project

1. Create a project at supabase.com (free tier).
2. Open the SQL editor and run both migration files in order:
   - `supabase/migrations/00000000000001_slice1.sql`
   - `supabase/migrations/00000000000002_slice2.sql`
3. Copy the **Session pooler** connection string from Project Settings → Database.
   It looks like `postgres://postgres.xxxx:PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres`.
   Add `?sslmode=require` to the end.
4. Save this as `DATABASE_URL` — you will need it in Step 3.

### Step 2 — Resend account

1. Sign up at resend.com (free tier).
2. Add and verify the domain you want to send from, or use the sandbox
   `onboarding@resend.dev` address for initial testing.
3. Create an API key. Your SMTP URL is:
   ```
   smtp://resend:YOUR_API_KEY@smtp.resend.com:465
   ```
4. Save this as `PULSE_SMTP_URL` — you will need it in Step 3.

### Step 3 — GitHub Actions workflow

Add `.github/workflows/pulse.yml` to the repository:

```yaml
name: Pulse

on:
  schedule:
    - cron: "0 7 * * *"   # 07:00 UTC daily
  workflow_dispatch:        # manual trigger for testing

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run src/cli/index.ts
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          PULSE_SMTP_URL: ${{ secrets.PULSE_SMTP_URL }}
          PULSE_SUBSCRIBER_EMAIL: ${{ secrets.PULSE_SUBSCRIBER_EMAIL }}
          PULSE_EMAIL_FROM: "Platform Pulse <pulse@yourdomain.com>"
```

Add `DATABASE_URL`, `PULSE_SMTP_URL`, and `PULSE_SUBSCRIBER_EMAIL` as repository
secrets under Settings → Secrets → Actions.

Use **Run workflow** in the Actions tab to trigger a manual run and confirm an
email arrives before waiting for the scheduled run.

---

## After the prototype is proven

Once daily email delivery is working, the slices below are roughly in priority
order. None of them are blockers for the prototype.

---

## Slice 3 — Subscription filtering

**Goal:** a subscriber's `taxonomies` and `significance_floor` columns actually
filter their digest.

The `subscription` table already carries both columns; `assembleDigest` in
`src/store/store.ts` ignores them. This slice wires them up:

1. Read `taxonomies` and `significance_floor` from the subscription row inside
   `assembleDigest`.
2. Filter `pending` change events: drop any event whose `taxonomy[0]` is not in
   `taxonomies` (when non-empty) and whose `significance` is below
   `significance_floor`.
3. Add an integration test that creates a subscription with `taxonomies = ['css']`
   and confirms non-CSS events are excluded.

No schema migration required.

---

## Slice 4 — Cadence-window batching

**Goal:** replace the "everything not yet delivered" shortcut in `assembleDigest`
with real time-window boundaries.

The comment at `src/store/store.ts:191` names this slice 5 in the original spec.

1. Compute `windowEnd` as `windowStart + cadence` (daily = +1 day, weekly = +7 days).
2. Only include events whose `first_observed_at` falls within `[windowStart, windowEnd)`.
3. Skip assembly if the window has not yet elapsed.
4. Add integration tests for daily and weekly cadences across multiple simulated days.

---

## Slice 5 — Richer taxonomy (group-graph walk)

**Goal:** replace the spec-URL heuristic in `src/core/web-features/diff.ts:55`
with a real taxonomy derived from the `web-features` group graph.

1. Extend `deriveIndex` to read the group hierarchy from the data payload.
2. Walk up the group graph to assign a canonical theme: `css`, `html`,
   `javascript`, `api`, `runtime`.
3. Fall back to the existing URL heuristic for features with no group.

No pipeline or schema changes — better digest grouping only.

---

## Slice 6 — Second adapter: browser releases

**Goal:** add a `browser-release` adapter so the digest covers actual browser
shipping events alongside Baseline transitions.

The `ChangeEventType` union and the significance scorer already handle
`browser-release`.

1. Create `src/adapters/browser-releases.ts` against a release feed (e.g.
   `mdn/browser-compat-data` release tags or the Chrome Releases RSS).
2. Wire it into `runPipeline` alongside the web-features adapter.
3. Add fixture-driven unit tests and extend the pipeline integration test.

---

## Slice 7 — Reader SPA deployment

**Goal:** make the digest browsable at a URL, not just in email.

Once the email prototype is proven this becomes worthwhile. The lowest-effort
path:

1. Replace the `digestApi` Vite plugin in `vite.config.ts` with a call to the
   Supabase JS client (`@supabase/supabase-js`), using the anon key and a
   Postgres view or RPC that the anon role can read.
2. Add RLS policies to a new migration so only the subscriber can read their own
   digests.
3. Deploy the built SPA to Cloudflare Pages or Vercel (both free tiers; connect
   the GitHub repo and it deploys on every push to `main`).

---

## Slice 8 — Production scheduling

**Goal:** replace the GitHub Actions cron with a proper scheduled worker so the
pipeline survives without a GitHub account and has retry logic.

Options, in order of effort:
- **Supabase Edge Function + pg_cron** — keeps everything inside Supabase;
  zero external services.
- **Cloudflare Worker + Cron Trigger** — free tier, runs Bun-compatible code,
  no container overhead.
- **Railway or Render cron** — one-command deploy of the existing CLI script.

---

## Open questions to resolve after the prototype

- **Sending domain**: for the prototype the Resend sandbox address works; for
  real use you need a verified domain. Do this before sharing the digest with
  anyone beyond yourself.
- **Cold-start window**: `COLD_START_WINDOW_DAYS = 7` in `diff.ts` is hardcoded.
  If the first production run fires more than 7 days after any recent Baseline
  transition, the digest will be empty. Consider a one-time manual run with
  `--data tests/fixtures/web-features/new.json` against the live DB to seed it,
  or bump the window constant before the first run.
- **Multi-subscriber**: the store is already multi-tenant but `ensureOperator`
  hard-codes a single email. Fine for v1; revisit when you want to share the
  digest with others.
