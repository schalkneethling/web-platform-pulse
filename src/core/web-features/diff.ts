import { withinColdStartWindow } from "../cold-start.ts";
import type { CandidateEvent } from "../types.ts";

export type BaselineValue = "high" | "low" | false;

interface WebFeatureStatus {
  baseline: BaselineValue;
  baseline_low_date?: string;
  baseline_high_date?: string;
  support: Record<string, string>;
}

interface WebFeatureEntry {
  kind: "feature" | "moved" | "split";
  name?: string;
  description?: string;
  group?: string[];
  spec?: string[];
  caniuse?: string[];
  status?: WebFeatureStatus;
  redirect_target?: string;
}

export interface WebFeaturesData {
  features: Record<string, WebFeatureEntry>;
}

export interface IndexedFeature {
  name: string;
  baseline: BaselineValue;
  lowDate?: string;
  highDate?: string;
  support: Record<string, string>;
  taxonomy: string[];
}

export type FeatureIndex = Record<string, IndexedFeature>;

const SOURCE_ID = "web-features";

const BROWSER_LABELS: Record<string, string> = {
  chrome: "Chrome",
  chrome_android: "Chrome on Android",
  edge: "Edge",
  firefox: "Firefox",
  firefox_android: "Firefox on Android",
  safari: "Safari",
  safari_ios: "Safari on iOS",
};

/**
 * v1 taxonomy is a coarse bucket derived from the specification URL,
 * isolated here so it can be replaced by a group-graph walk later (§8.1).
 */
const deriveTaxonomy = (spec: string[] = []): string[] => {
  const url = spec[0] ?? "";
  if (url.includes("csswg.org") || url.includes("fxtf.org")) return ["css"];
  if (url.includes("html.spec.whatwg.org")) return ["html"];
  if (url.includes("tc39.es")) return ["javascript"];
  if (url.includes("ecma-international.org")) return ["javascript"];
  return ["api"];
};

export const deriveIndex = (data: WebFeaturesData): FeatureIndex => {
  const index: FeatureIndex = {};
  for (const [id, entry] of Object.entries(data.features)) {
    if (entry.kind !== "feature" || !entry.status) continue;
    index[id] = {
      name: entry.name ?? id,
      baseline: entry.status.baseline,
      ...(entry.status.baseline_low_date !== undefined && {
        lowDate: entry.status.baseline_low_date,
      }),
      ...(entry.status.baseline_high_date !== undefined && {
        highDate: entry.status.baseline_high_date,
      }),
      support: entry.status.support ?? {},
      taxonomy: deriveTaxonomy(entry.spec),
    };
  }
  return index;
};

/** Dates may be ranged ("≤2022-09-24"); the bound is the usable date. */
const parseRangedDate = (date: string | undefined): string | null => {
  if (!date) return null;
  return date.startsWith("≤") ? date.slice(1) : date;
};

const featureUrl = (id: string): string => `https://webstatus.dev/features/${id}`;

const baselineLabel = (value: BaselineValue): string =>
  value === "high" ? "Baseline widely available" : "Baseline newly available";

interface DiffOptions {
  now: Date;
  observedAt: string;
}

const baselineCandidate = (
  id: string,
  feature: IndexedFeature,
  before: BaselineValue,
  observedAt: string,
): CandidateEvent => {
  const occurredAt = parseRangedDate(
    feature.baseline === "high" ? feature.highDate : feature.lowDate,
  );
  return {
    type: "baseline-change",
    subject: { kind: "feature", id },
    title: `${feature.name} is now ${baselineLabel(feature.baseline)}`,
    before: { baseline: before },
    after: { baseline: feature.baseline },
    occurredAt,
    taxonomy: feature.taxonomy,
    dedupeKey: `web-features:baseline:${id}:${String(before)}->${String(feature.baseline)}`,
    correlationKey: `baseline:${id}:${String(feature.baseline)}`,
    provenance: [{ sourceId: SOURCE_ID, url: featureUrl(id), title: feature.name, observedAt }],
  };
};

const supportCandidate = (
  id: string,
  feature: IndexedFeature,
  browser: string,
  before: string | null,
  version: string,
  observedAt: string,
): CandidateEvent => {
  const browserLabel = BROWSER_LABELS[browser] ?? browser;
  return {
    type: "browser-support",
    subject: { kind: "feature", id },
    title: `${browserLabel} ${version} supports ${feature.name}`,
    before: before === null ? null : { browser, version: before },
    after: { browser, version },
    occurredAt: null,
    taxonomy: feature.taxonomy,
    dedupeKey: `web-features:support:${id}:${browser}:${version}`,
    correlationKey: `support:${id}:${browser}:${version}`,
    provenance: [{ sourceId: SOURCE_ID, url: featureUrl(id), title: feature.name, observedAt }],
  };
};

/**
 * Cold start (§5.3): with no prior index the catalogue is seeded silently,
 * emitting only baseline transitions dated within the window before now.
 */
const coldStartEvents = (next: FeatureIndex, options: DiffOptions): CandidateEvent[] => {
  const events: CandidateEvent[] = [];
  for (const [id, feature] of Object.entries(next)) {
    if (feature.baseline === false) continue;
    const date = parseRangedDate(feature.baseline === "high" ? feature.highDate : feature.lowDate);
    if (!withinColdStartWindow(date, options.now)) continue;
    const before: BaselineValue = feature.baseline === "high" ? "low" : false;
    events.push(baselineCandidate(id, feature, before, options.observedAt));
  }
  return events;
};

export const diffWebFeatures = (
  prev: FeatureIndex | null,
  next: FeatureIndex,
  options: DiffOptions,
): CandidateEvent[] => {
  if (prev === null) return coldStartEvents(next, options);

  const events: CandidateEvent[] = [];
  for (const [id, feature] of Object.entries(next)) {
    const previous = prev[id];

    if (!previous) {
      if (feature.baseline !== false) {
        events.push(baselineCandidate(id, feature, false, options.observedAt));
      }
      continue;
    }

    if (previous.baseline !== feature.baseline && feature.baseline !== false) {
      events.push(baselineCandidate(id, feature, previous.baseline, options.observedAt));
    }

    for (const [browser, version] of Object.entries(feature.support)) {
      const previousVersion = previous.support[browser] ?? null;
      if (previousVersion === version) continue;
      events.push(
        supportCandidate(id, feature, browser, previousVersion, version, options.observedAt),
      );
    }
  }
  return events;
};
