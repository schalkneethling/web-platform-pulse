// The prototype trigger (§12): one idempotent run of the whole pipeline.
//   vp run pulse              pulls live web-features data and release feeds
//   vp run pulse -- --data tests/fixtures/web-features/new.json
//   vp run pulse -- --releases tests/fixtures/browser-releases/new.json
//   vp run pulse -- --smtp smtp://localhost:54330   (or PULSE_SMTP_URL)
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  createBrowserReleasesAdapter,
  fetchBrowserReleases,
} from "../adapters/browser-releases.ts";
import { createWebFeaturesAdapter, fetchWebFeaturesData } from "../adapters/web-features.ts";
import type { BrowserRelease } from "../core/browser-releases/diff.ts";
import type { WebFeaturesData } from "../core/web-features/diff.ts";
import { createEmailChannel } from "../delivery/email.ts";
import { createSmtpSender } from "../delivery/smtp.ts";
import { connect } from "../store/db.ts";
import { runPipeline } from "./pipeline.ts";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    releases: { type: "string" },
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

const adapters = [
  createWebFeaturesAdapter({ fetchData }),
  createBrowserReleasesAdapter({ fetchReleases }),
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
      `digest: ${summary.digestId ?? "none (nothing new)"} | ` +
      `email: ${summary.deliveries.sent} sent, ${summary.deliveries.failed} failed${failures}`,
  );
} finally {
  await sql.end();
}
