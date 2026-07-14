export type ChangeEventType =
  | "baseline-change"
  | "browser-support"
  | "spec-change"
  | "vendor-position"
  | "feature-status"
  | "browser-release"
  | "runtime-release"
  | "tag-review"
  | "editorial";

export type Subject =
  | { kind: "feature"; id: string }
  | { kind: "spec"; shortname: string }
  | { kind: "browser"; name: "chrome" | "firefox" | "safari"; version: string }
  | { kind: "runtime"; name: "node" | "deno" | "bun"; version: string }
  | { kind: "tag-review"; number: number }
  | { kind: "post"; source: string; url: string };

export interface Provenance {
  sourceId: string;
  url: string;
  title: string;
  observedAt: string;
  rawRef?: string;
}

/**
 * What an adapter emits: a change event minus the fields only the
 * pipeline can assign (id, significance, observation timestamps).
 * `title` is the human-readable one-liner every renderer needs.
 */
export interface CandidateEvent {
  type: ChangeEventType;
  subject: Subject;
  title: string;
  before: unknown;
  after: unknown;
  occurredAt: string | null;
  taxonomy: string[];
  dedupeKey: string;
  correlationKey: string;
  provenance: Provenance[];
}

export interface ChangeEvent extends CandidateEvent {
  id: string;
  significance: number;
  firstObservedAt: string;
  lastUpdatedAt: string;
}
