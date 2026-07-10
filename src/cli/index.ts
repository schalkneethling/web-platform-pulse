// The prototype trigger (§12): one idempotent run of the whole pipeline.
//   vp run pulse              pulls live web-features data and release feeds
//   vp run pulse -- --data tests/fixtures/web-features/new.json
//   vp run pulse -- --releases tests/fixtures/browser-releases/new.json
//   vp run pulse -- --runtimes tests/fixtures/runtime-releases/new.json
//   vp run pulse -- --positions tests/fixtures/standards-positions/new.json
//   vp run pulse -- --chrome tests/fixtures/chrome-status/new.json
//   vp run pulse -- --specs tests/fixtures/w3c-specs/new.json
//   vp run pulse -- --smtp smtp://localhost:54330   (or PULSE_SMTP_URL)
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  createBrowserReleasesAdapter,
  fetchBrowserReleases,
} from "../adapters/browser-releases.ts";
import {
  createRuntimeReleasesAdapter,
  fetchRuntimeReleases,
} from "../adapters/runtime-releases.ts";
import { createChromeStatusAdapter, fetchChromeFeatures } from "../adapters/chrome-status.ts";
import {
  createStandardsPositionsAdapter,
  fetchVendorPositions,
} from "../adapters/standards-positions.ts";
import { createWebFeaturesAdapter, fetchWebFeaturesData } from "../adapters/web-features.ts";
import { createW3CSpecsAdapter, fetchW3CSpecs } from "../adapters/w3c-specs.ts";
import type { BrowserRelease } from "../core/browser-releases/diff.ts";
import type { RuntimeRelease } from "../core/runtime-releases/diff.ts";
import type { ChromeFeature } from "../core/chrome-status/diff.ts";
import type { VendorPosition } from "../core/standards-positions/diff.ts";
import type { WebFeaturesData } from "../core/web-features/diff.ts";
import type { W3CSpec } from "../core/w3c-specs/diff.ts";
import { createEmailChannel } from "../delivery/email.ts";
import { createSmtpSender } from "../delivery/smtp.ts";
import { connect } from "../store/db.ts";
import { runPipeline } from "./pipeline.ts";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    releases: { type: "string" },
    runtimes: { type: "string" },
    positions: { type: "string" },
    chrome: { type: "string" },
    specs: { type: "string" },
    email: { type: "string" },
    smtp: { type: "string" },
  },
});

const loadJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

const dataPath = values.data;
const fetchData = dataPath
  ? () => Promise.resolve(loadJson<WebFeaturesData>(dataPath))
  : fetchWebFeaturesData;

const releasesPath = values.releases;
const fetchReleases = releasesPath
  ? () => Promise.resolve(loadJson<BrowserRelease[]>(releasesPath))
  : fetchBrowserReleases;

const runtimesPath = values.runtimes;
const fetchRuntimes = runtimesPath
  ? () => Promise.resolve(loadJson<RuntimeRelease[]>(runtimesPath))
  : fetchRuntimeReleases;

const positionsPath = values.positions;
const fetchPositions = positionsPath
  ? () => Promise.resolve(loadJson<VendorPosition[]>(positionsPath))
  : fetchVendorPositions;

const chromePath = values.chrome;
const fetchChrome = chromePath
  ? () => Promise.resolve(loadJson<ChromeFeature[]>(chromePath))
  : fetchChromeFeatures;

const specsPath = values.specs;
const fetchSpecs = specsPath
  ? () => Promise.resolve(loadJson<W3CSpec[]>(specsPath))
  : fetchW3CSpecs;

const adapters = [
  createWebFeaturesAdapter({ fetchData }),
  createBrowserReleasesAdapter({ fetchReleases }),
  createRuntimeReleasesAdapter({ fetchReleases: fetchRuntimes }),
  createStandardsPositionsAdapter({ fetchPositions }),
  createChromeStatusAdapter({ fetchFeatures: fetchChrome }),
  createW3CSpecsAdapter({ fetchSpecs }),
];

const subscriberEmail =
  values.email ?? process.env.PULSE_SUBSCRIBER_EMAIL ?? "operator@example.com";

// Email is opt-in for the prototype: no SMTP configured means the reader
// channel (the persisted digest) is the only delivery.
const smtpUrl = values.smtp ?? process.env.PULSE_SMTP_URL;
const channels = smtpUrl
  ? [
      createEmailChannel({
        from: process.env.PULSE_EMAIL_FROM ?? "Platform Pulse <pulse@localhost>",
        send: createSmtpSender(smtpUrl),
      }),
    ]
  : [];

const sql = connect();
try {
  const summary = await runPipeline(sql, { adapters, subscriberEmail, channels });
  const failures =
    summary.sourceFailures.length > 0
      ? ` | sources failed: ${summary.sourceFailures.join(", ")}`
      : "";
  console.log(
    `candidates: ${summary.candidates} | created: ${summary.ingest.created}, ` +
      `correlated: ${summary.ingest.correlated}, unchanged: ${summary.ingest.unchanged} | ` +
      `digests: ${summary.digestIds.length > 0 ? summary.digestIds.join(", ") : "none (no closed window)"} | ` +
      `email: ${summary.deliveries.sent} sent, ${summary.deliveries.failed} failed${failures}`,
  );
  // A broken feed or transport must not stay green: everything healthy
  // already delivered, but the run fails so the operator notices.
  if (summary.sourceFailures.length > 0 || summary.deliveries.failed > 0) {
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
