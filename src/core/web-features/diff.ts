import { withinColdStartWindow } from "../cold-start.ts";
import { deriveTaxonomy, themesForFeature, type GroupGraph } from "../taxonomy.ts";
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
  /** Absent from old artifacts and hand-written fixtures; treated as empty. */
  groups?: GroupGraph;
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

export const BROWSER_LABELS: Record<string, string> = {
  chrome: "Chrome",
  chrome_android: "Chrome on Android",
  edge: "Edge",
  firefox: "Firefox",
  firefox_android: "Firefox on Android",
  safari: "Safari",
  safari_ios: "Safari on iOS",
};

/**
 * The taxonomy is derived at read time, and the stored cursor is the derived
 * index, so a feature's taxonomy can differ between the cursor and the next
 * run. That is harmless because `diffWebFeatures` compares baseline and
 * support only: a taxonomy change alone never produces an event.
 */
export const deriveIndex = (data: WebFeaturesData): FeatureIndex => {
  const graph = data.groups ?? {};
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
      taxonomy: deriveTaxonomy(entry, graph),
    };
  }
  return index;
};

/**
 * Themes for a web-features id, for sources that carry such an id but
 * classify features their own way. `undefined` means this data has no answer
 * (unknown id, or a feature with no group and no recognised spec), so the
 * caller keeps its own classification instead of being told "api".
 */
export const createThemeLookup =
  (data: WebFeaturesData) =>
  (id: string): string[] | undefined => {
    const entry = data.features[id];
    if (entry?.kind !== "feature") return undefined;
    const themes = themesForFeature(entry, data.groups ?? {});
    return themes.length > 0 ? themes : undefined;
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
