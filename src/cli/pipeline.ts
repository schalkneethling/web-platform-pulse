import {
  createWebFeaturesAdapter,
  WEB_FEATURES_SOURCE_ID,
  type WebFeaturesAdapterOptions,
} from "../adapters/web-features.ts";
import type { DeliveryChannel } from "../core/delivery.ts";
import type { FeatureIndex } from "../core/web-features/diff.ts";
import type { Sql } from "../store/db.ts";
import {
  assembleDigest,
  digestsAwaitingDelivery,
  ensureOperator,
  ensureSource,
  getDigest,
  ingestCandidates,
  loadSourceState,
  recordDelivery,
  saveSourceState,
  type IngestResult,
} from "../store/store.ts";

export interface PipelineOptions extends WebFeaturesAdapterOptions {
  subscriberEmail: string;
  channels?: DeliveryChannel[];
}

export interface DeliverySummary {
  sent: number;
  failed: number;
}

export interface PipelineSummary {
  candidates: number;
  ingest: IngestResult;
  digestId: string | null;
  deliveries: DeliverySummary;
}

/**
 * Deliver every digest a channel has not yet sent (§10) — not just this
 * run's digest, so a run with nothing new still retries earlier failures.
 */
const deliverPending = async (sql: Sql, channels: DeliveryChannel[]): Promise<DeliverySummary> => {
  const summary: DeliverySummary = { sent: 0, failed: 0 };
  for (const channel of channels) {
    for (const pending of await digestsAwaitingDelivery(sql, channel.id)) {
      const digest = await getDigest(sql, pending.digestId);
      if (digest === null) continue;
      const result = await channel.send(digest, { email: pending.email });
      await recordDelivery(sql, pending.digestId, channel.id, result);
      summary[result.status] += 1;
    }
  }
  return summary;
};

/**
 * One idempotent end-to-end run (§12): adapter → correlation/ingest →
 * digest assembly → delivery. The prototype CLI and the e2e seed both
 * call this; the production Worker will run the same function.
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
  const deliveries = await deliverPending(sql, options.channels ?? []);

  return { candidates: events.length, ingest, digestId, deliveries };
};
