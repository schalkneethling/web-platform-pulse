// The pipeline run and the confirmations-only run: everything `vp run pulse`
// does when no `issue` subcommand is given. It lives apart from index.ts so
// that building the adapters and reading the operator address happen only for
// the commands that need them, never for `issue open`.
import { readFileSync } from "node:fs";
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
import { createTagReviewsAdapter, fetchTagReviews } from "../adapters/tag-reviews.ts";
import { createVoicesAdapter, fetchVoicePosts } from "../adapters/voices.ts";
import type { BrowserRelease } from "../core/browser-releases/diff.ts";
import type { RuntimeRelease } from "../core/runtime-releases/diff.ts";
import type { ChromeFeature } from "../core/chrome-status/diff.ts";
import type { VendorPosition } from "../core/standards-positions/diff.ts";
import type { WebFeaturesData } from "../core/web-features/diff.ts";
import type { W3CSpec } from "../core/w3c-specs/diff.ts";
import type { TagReview } from "../core/tag-reviews/diff.ts";
import type { VoicePost } from "../core/voices/diff.ts";
import { createEmailChannel } from "../delivery/email.ts";
import { createSmtpSender } from "../delivery/smtp.ts";
import { connect } from "../store/db.ts";
import { sendPendingConfirmations } from "./confirmations.ts";
import { runPipeline } from "./pipeline.ts";
import type { CliValues } from "./command.ts";
import { readSettings } from "./config.ts";

export const runPipelineCommand = async (
  values: CliValues,
  confirmationsOnly: boolean,
): Promise<void> => {
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

  const tagReviewsPath = values["tag-reviews"];
  const fetchReviews = tagReviewsPath
    ? () => Promise.resolve(loadJson<TagReview[]>(tagReviewsPath))
    : fetchTagReviews;

  const voicesPath = values.voices;
  const fetchPosts = voicesPath
    ? () => Promise.resolve(loadJson<VoicePost[]>(voicesPath))
    : fetchVoicePosts;

  const adapters = [
    createWebFeaturesAdapter({ fetchData }),
    createBrowserReleasesAdapter({ fetchReleases }),
    createRuntimeReleasesAdapter({ fetchReleases: fetchRuntimes }),
    createStandardsPositionsAdapter({ fetchPositions }),
    createChromeStatusAdapter({ fetchFeatures: fetchChrome }),
    createW3CSpecsAdapter({ fetchSpecs }),
    createTagReviewsAdapter({ fetchReviews }),
    createVoicesAdapter({ fetchPosts }),
  ];

  const settings = readSettings(values, process.env);

  // No fallback address: ensureOperator moves the operator flag to whatever
  // address it is given, so a guessed default would silently re-point the public
  // reader at a stranger's digest. Only the pipeline needs it. `confirmations`
  // never touches the operator, so its workflow is not handed the address.
  if (!confirmationsOnly && !settings.operatorEmail) {
    console.error(
      "The operator address is required: set PULSE_SUBSCRIBER_EMAIL or pass --email. " +
        "It names the operator whose digest the public reader shows.",
    );
    process.exit(2);
  }
  const operatorEmail = confirmationsOnly ? null : (settings.operatorEmail ?? null);

  // Email is opt-in for the prototype: no SMTP configured means the reader
  // channel (the persisted digest) is the only delivery.
  const emailFrom = settings.from;
  const send = settings.smtpUrl ? createSmtpSender(settings.smtpUrl) : null;

  // Confirmation and unsubscribe links are built on the reader's public origin. Failing here,
  // before any mail is sent, beats mailing a link that points nowhere.
  const publicUrl = settings.publicUrl;
  if (send && !publicUrl) {
    console.error(
      "PULSE_PUBLIC_URL is required when SMTP is configured: it is the base of the confirmation and unsubscribe links.",
    );
    process.exit(2);
  }
  if (confirmationsOnly && !send) {
    console.error("confirmations needs SMTP: set PULSE_SMTP_URL or pass --smtp.");
    process.exit(2);
  }

  const channels =
    send && publicUrl ? [createEmailChannel({ from: emailFrom, send, publicUrl })] : [];

  const sql = connect();
  try {
    if (operatorEmail !== null) {
      const summary = await runPipeline(sql, {
        adapters,
        subscriberEmail: operatorEmail,
        channels,
      });
      const failures =
        summary.sourceFailures.length > 0
          ? ` | sources failed: ${summary.sourceFailures.join(", ")}`
          : "";
      const subscriberFailures =
        summary.subscriberFailures.length > 0
          ? ` | subscribers failed: ${summary.subscriberFailures.join(", ")}`
          : "";
      console.log(
        `candidates: ${summary.candidates} | created: ${summary.ingest.created}, ` +
          `correlated: ${summary.ingest.correlated}, unchanged: ${summary.ingest.unchanged} | ` +
          `digests: ${summary.digestIds.length > 0 ? summary.digestIds.join(", ") : "none (no closed window)"} | ` +
          `email: ${summary.deliveries.sent} sent, ${summary.deliveries.failed} failed${failures}${subscriberFailures}`,
      );
      // A broken feed or transport must not stay green: everything healthy
      // already delivered, but the run fails so the operator notices.
      if (
        summary.sourceFailures.length > 0 ||
        summary.subscriberFailures.length > 0 ||
        summary.deliveries.failed > 0
      ) {
        process.exitCode = 1;
      }
    }

    if (send && publicUrl) {
      const confirmations = await sendPendingConfirmations(sql, {
        send,
        from: emailFrom,
        publicUrl,
      });
      console.log(
        `confirmations: ${confirmations.sent} sent, ${confirmations.failed} failed, ` +
          `${confirmations.cleaned} stale signups removed`,
      );
      if (confirmations.failed > 0) process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
};
