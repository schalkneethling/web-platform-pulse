import type { CandidateEvent } from "./types.ts";

/**
 * The seam between sources and the pipeline (§5): each source is an
 * adapter that turns "what changed upstream since this cursor" into
 * candidate events plus the next cursor. The pipeline persists cursors
 * per source; adapters stay pure over their fetched payloads.
 */
export interface SourceAdapter<Cursor = unknown> {
  readonly sourceId: string;
  /** How this source observes change; stored on the source row. */
  readonly kind: string;
  run(cursor: Cursor | null): Promise<{ events: CandidateEvent[]; cursor: Cursor }>;
}
