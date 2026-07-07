import type { CandidateEvent } from "../types.ts";

/**
 * One Chrome Platform Status entry, normalized from the chromestatus.com
 * API. `status` keeps the site's native vocabulary ("Enabled by default",
 * "Origin trial", "Deprecated", …); `webFeature` is the web-features id
 * when Chromium has mapped one, aligning subjects with the Baseline source.
 */
export interface ChromeFeature {
  /** chromestatus numeric id, as a string — stable per feature. */
  id: string;
  name: string;
  status: string;
  /** Chrome milestone the status applies to, when the site carries one. */
  milestone: string | null;
  webFeature: string | null;
  specUrl: string | null;
  category: string;
}

/** The cursor: the last Chrome status seen per feature id. */
export type ChromeStatusIndex = Record<string, string>;

const SOURCE_ID = "chrome-status";

/**
 * The chromestatus status texts this differ phrases and scores; the one
 * source of truth so titles and significance cannot drift apart.
 */
export const CHROME_STATUS = {
  shipped: "Enabled by default",
  originTrial: "Origin trial",
  devTrial: "In developer trial (Behind a flag)",
  deprecated: "Deprecated",
  removed: "Removed",
  inDevelopment: "In development",
  proposed: "Proposed",
} as const;

const inChrome = (milestone: string | null): string =>
  milestone === null ? "Chrome" : `Chrome ${milestone}`;

/**
 * Status texts phrased for a digest one-liner. Anything chromestatus
 * invents later falls back to a neutral "Chrome status for X: value".
 */
const STATUS_PHRASES: Record<string, (feature: ChromeFeature) => string> = {
  [CHROME_STATUS.shipped]: (f) => `${f.name} shipped in ${inChrome(f.milestone)}`,
  [CHROME_STATUS.originTrial]: (f) => `${f.name} entered origin trial in ${inChrome(f.milestone)}`,
  [CHROME_STATUS.devTrial]: (f) => `${f.name} available behind a flag in ${inChrome(f.milestone)}`,
  [CHROME_STATUS.deprecated]: (f) => `${f.name} deprecated in ${inChrome(f.milestone)}`,
  [CHROME_STATUS.removed]: (f) => `${f.name} removed from ${inChrome(f.milestone)}`,
  [CHROME_STATUS.inDevelopment]: (f) => `${f.name} in development for Chrome`,
  [CHROME_STATUS.proposed]: (f) => `${f.name} proposed for Chrome`,
};

const statusTitle = (feature: ChromeFeature): string => {
  const phrase = STATUS_PHRASES[feature.status];
  return phrase ? phrase(feature) : `Chrome status for ${feature.name}: ${feature.status}`;
};

/** chromestatus categories are finer than digest themes (§9). */
const themeFromCategory = (category: string): string => {
  const lowered = category.toLowerCase();
  if (lowered === "css") return "css";
  if (lowered === "html") return "html";
  if (lowered === "javascript") return "javascript";
  return "api";
};

const statusSlug = (status: string): string =>
  status
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

export const deriveChromeStatusIndex = (features: ChromeFeature[]): ChromeStatusIndex => {
  const index: ChromeStatusIndex = {};
  for (const feature of features) {
    index[feature.id] = feature.status;
  }
  return index;
};

const statusCandidate = (
  feature: ChromeFeature,
  before: string | null,
  observedAt: string,
): CandidateEvent => {
  const title = statusTitle(feature);
  // Keyed by transition, not destination: features revisit statuses (a
  // second origin trial, deprecated then re-enabled), and a
  // destination-only key would collide with the earlier event's
  // dedupe_key and swallow the new item at ingest.
  const transition = `${statusSlug(before ?? "unseen")}-to-${statusSlug(feature.status)}`;
  return {
    type: "feature-status",
    subject: { kind: "feature", id: feature.webFeature ?? `chromestatus/${feature.id}` },
    title,
    before: before === null ? null : { status: before },
    after: {
      status: feature.status,
      milestone: feature.milestone,
      specUrl: feature.specUrl,
    },
    // updated.when is edit time, not transition time; observation is all we have.
    occurredAt: null,
    taxonomy: [themeFromCategory(feature.category)],
    dedupeKey: `chrome-status:feature:${feature.id}:${transition}`,
    correlationKey: `feature-status:chrome:${feature.id}:${transition}`,
    provenance: [
      {
        sourceId: SOURCE_ID,
        url: `https://chromestatus.com/feature/${feature.id}`,
        title,
        observedAt,
      },
    ],
  };
};

/**
 * Cold start (§5.3): the dump's timestamps record edits, not status
 * transitions, so there is no window to replay — the first run seeds
 * every known status silently and events flow from the next change on.
 */
export const diffChromeStatus = (
  prev: ChromeStatusIndex | null,
  features: ChromeFeature[],
  options: { observedAt: string },
): CandidateEvent[] => {
  if (prev === null) return [];

  const events: CandidateEvent[] = [];
  for (const feature of features) {
    const before = prev[feature.id] ?? null;
    if (before === feature.status) continue;
    events.push(statusCandidate(feature, before, options.observedAt));
  }
  return events;
};
