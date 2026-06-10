import {
  createWebFeaturesAdapter,
  WEB_FEATURES_SOURCE_ID,
  type WebFeaturesAdapterOptions,
} from "../adapters/web-features.ts";
import type { FeatureIndex } from "../core/web-features/diff.ts";
import type { Sql } from "../store/db.ts";
import {
  assembleDigest,
  ensureOperator,
  ensureSource,
  ingestCandidates,
  loadSourceState,
  saveSourceState,
  type IngestResult,
} from "../store/store.ts";

export interface PipelineOptions extends WebFeaturesAdapterOptions {
  subscriberEmail: string;
}

export interface PipelineSummary {
  candidates: number;
  ingest: IngestResult;
  digestId: string | null;
}

/**
 * One idempotent end-to-end run (§12): adapter → correlation/ingest →
 * digest assembly. The prototype CLI and the e2e seed both call this;
 * the production Worker will run the same function.
 */
export const runPipeline = async (sql: Sql, options: PipelineOptions): Promise<PipelineSummary> => {
  const adapter = createWebFeaturesAdapter(options);

  await ensureSource(sql, adapter.sourceId, "artifact-diff");
  const subscriberId = await ensureOperator(sql, options.subscriberEmail);

  const cursor = await loadSourceState<FeatureIndex>(sql, WEB_FEATURES_SOURCE_ID);
  const { events, cursor: nextCursor } = await adapter.run(cursor);

  const ingest = await ingestCandidates(sql, events);
  await saveSourceState(sql, WEB_FEATURES_SOURCE_ID, nextCursor);

  const digestId = await assembleDigest(sql, subscriberId);

  return { candidates: events.length, ingest, digestId };
};
