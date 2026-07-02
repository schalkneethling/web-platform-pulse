import type { SourceAdapter } from "../core/adapter.ts";
import {
  deriveIndex,
  diffWebFeatures,
  type FeatureIndex,
  type WebFeaturesData,
} from "../core/web-features/diff.ts";

export const WEB_FEATURES_SOURCE_ID = "web-features";

/** The published artifact this differ observes (§5.3). */
export const WEB_FEATURES_DATA_URL = "https://cdn.jsdelivr.net/npm/web-features@latest/data.json";

export interface WebFeaturesAdapterOptions {
  fetchData: () => Promise<WebFeaturesData>;
  now?: () => Date;
}

export const fetchWebFeaturesData = async (): Promise<WebFeaturesData> => {
  const response = await fetch(WEB_FEATURES_DATA_URL);
  if (!response.ok) {
    throw new Error(`web-features fetch failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as WebFeaturesData;
};

export const createWebFeaturesAdapter = (
  options: WebFeaturesAdapterOptions,
): SourceAdapter<FeatureIndex> => {
  const now = options.now ?? (() => new Date());
  return {
    sourceId: WEB_FEATURES_SOURCE_ID,
    kind: "artifact-diff",
    run: async (cursor) => {
      const data = await options.fetchData();
      const next = deriveIndex(data);
      const current = now();
      const events = diffWebFeatures(cursor, next, {
        now: current,
        observedAt: current.toISOString(),
      });
      return { events, cursor: next };
    },
  };
};
