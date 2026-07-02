import type { SourceAdapter } from "../core/adapter.ts";
import type { DeliveryChannel } from "../core/delivery.ts";
import type { CandidateEvent } from "../core/types.ts";
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

export interface PipelineOptions {
  adapters: SourceAdapter[];
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
  sourceFailures: string[];
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
 * One idempotent end-to-end run (§12): adapters → correlation/ingest →
 * digest assembly → delivery. A failed source is skipped and retried from
 * its saved cursor next run; it must not block the other sources. The
 * prototype CLI and the e2e seed both call this; the production Worker
 * will run the same function.
 */
export const runPipeline = async (sql: Sql, options: PipelineOptions): Promise<PipelineSummary> => {
  const subscriberId = await ensureOperator(sql, options.subscriberEmail);

  const candidates: CandidateEvent[] = [];
  const cursors: [string, unknown][] = [];
  const sourceFailures: string[] = [];

  for (const adapter of options.adapters) {
    await ensureSource(sql, adapter.sourceId, adapter.kind);
    const cursor = await loadSourceState(sql, adapter.sourceId);
    try {
      const result = await adapter.run(cursor);
      candidates.push(...result.events);
      cursors.push([adapter.sourceId, result.cursor]);
    } catch (error) {
      console.error(`source ${adapter.sourceId} failed:`, error);
      sourceFailures.push(adapter.sourceId);
    }
  }

  const ingest = await ingestCandidates(sql, candidates);
  for (const [sourceId, cursor] of cursors) {
    await saveSourceState(sql, sourceId, cursor);
  }

  const digestId = await assembleDigest(sql, subscriberId);
  const deliveries = await deliverPending(sql, options.channels ?? []);

  return { candidates: candidates.length, ingest, sourceFailures, digestId, deliveries };
};
