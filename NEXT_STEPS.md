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

The slices below are roughly in priority order.

---

## Slice D — Digest volume management

Chrome Platform Status alone can add several items on a busy day. Decide on
a per-theme cap with a "N more" fold in email and reader before the digest
bloats. The subscription `significance_floor` already provides a blunt
instrument; this slice is about presentation.

## Slice E — Richer taxonomy (group-graph walk)

Replace the spec-URL heuristic in `src/core/web-features/diff.ts` with a
taxonomy derived from the web-features group graph; browser-specs group
data can serve the other adapters. Gets more valuable with every source
added — it is what keeps a fatter digest well grouped.

## Slice F — Reader SPA deployment and multi-subscriber

Parked until the digest is shared beyond the operator: replace the
`digestApi` Vite plugin with Supabase reads + RLS, deploy the SPA
(Cloudflare Pages or Vercel), and lift the single-email `ensureOperator`.

---

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
