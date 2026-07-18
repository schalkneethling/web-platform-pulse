import type { ChangeEvent } from "./types.ts";
import { BROWSER_LABELS } from "./web-features/diff.ts";

/**
 * Browser-support events arrive one per (feature, browser, version), so a
 * single web-features data release fans out into near-identical bullets —
 * "Chrome 150 supports X", "Edge 150 supports X", … Rolling them up at
 * presentation time turns that fan-out back into the sentence a human
 * would write: "Chrome, Chrome on Android and Edge 150 now support X, Y
 * and Z." Events stay stored individually; only rendering changes.
 */
export interface RollupFeature {
  id: string;
  name: string;
  url: string;
}

export interface SupportRollup {
  /** "Chrome, Chrome on Android and Edge 150 now support" — renderers append the feature list. */
  lead: string;
  features: RollupFeature[];
}

const BROWSER_ORDER = Object.keys(BROWSER_LABELS);

const browserRank = (browser: string): number => {
  const rank = BROWSER_ORDER.indexOf(browser);
  return rank === -1 ? BROWSER_ORDER.length : rank;
};

/** "A", "A and B", "A, B and C" — matches the digest's en-GB prose. */
export const listJoin = (parts: string[]): string =>
  parts.length <= 1
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`;

interface SupportPair {
  browser: string;
  version: string;
}

interface FeatureSupport {
  feature: RollupFeature;
  pairs: SupportPair[];
}

const leadFor = (pairs: SupportPair[]): string => {
  const versions = new Set(pairs.map((pair) => pair.version));
  const label = (browser: string): string => BROWSER_LABELS[browser] ?? browser;
  const subject =
    versions.size === 1
      ? `${listJoin(pairs.map((pair) => label(pair.browser)))} ${pairs[0]?.version ?? ""}`
      : listJoin(pairs.map((pair) => `${label(pair.browser)} ${pair.version}`));
  return `${subject} ${pairs.length > 1 ? "now support" : "now supports"}`;
};

const supportPair = (event: ChangeEvent): SupportPair | null => {
  if (event.type !== "browser-support" || event.subject.kind !== "feature") return null;
  const after = event.after as { browser?: unknown; version?: unknown } | null;
  if (typeof after?.browser !== "string" || typeof after.version !== "string") return null;
  return { browser: after.browser, version: after.version };
};

/**
 * Partition a theme group's items into rollup-able browser-support events
 * and everything else. Features sharing the exact same set of (browser,
 * version) pairs share one rollup; the rest keep their original order.
 */
export const splitBrowserSupport = (
  items: ChangeEvent[],
): { rest: ChangeEvent[]; rollups: SupportRollup[] } => {
  const rest: ChangeEvent[] = [];
  const byFeature = new Map<string, FeatureSupport>();

  for (const item of items) {
    const pair = supportPair(item);
    if (pair === null) {
      rest.push(item);
      continue;
    }
    const id = (item.subject as { id: string }).id;
    const entry = byFeature.get(id) ?? {
      feature: {
        id,
        name: item.provenance[0]?.title ?? id,
        url: item.provenance[0]?.url ?? "",
      },
      pairs: [],
    };
    entry.pairs.push(pair);
    byFeature.set(id, entry);
  }

  const bySignature = new Map<string, { pairs: SupportPair[]; features: RollupFeature[] }>();
  for (const { feature, pairs } of byFeature.values()) {
    pairs.sort(
      (a, b) =>
        browserRank(a.browser) - browserRank(b.browser) ||
        a.browser.localeCompare(b.browser) ||
        a.version.localeCompare(b.version),
    );
    const signature = pairs.map((pair) => `${pair.browser}@${pair.version}`).join("|");
    const group = bySignature.get(signature) ?? { pairs, features: [] };
    group.features.push(feature);
    bySignature.set(signature, group);
  }

  const rollups = [...bySignature.values()]
    .map(({ pairs, features }) => ({
      lead: leadFor(pairs),
      features: features.sort((a, b) => a.name.localeCompare(b.name)),
      breadth: pairs.length,
    }))
    .sort(
      (a, b) =>
        b.features.length - a.features.length ||
        b.breadth - a.breadth ||
        a.lead.localeCompare(b.lead),
    )
    .map(({ lead, features }) => ({ lead, features }));

  return { rest, rollups };
};
