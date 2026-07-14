import type { CandidateEvent } from "../types.ts";

/**
 * One w3ctag/design-reviews issue, normalized from the GitHub issues API.
 * `verdict` is derived from the issue's `Resolution: <verdict>` label
 * (satisfied, unsatisfied, …) when the TAG has recorded one; open reviews
 * and closed reviews the TAG never labelled both carry `verdict: null`.
 */
export interface TagReview {
  /** The GitHub issue number — stable per review. */
  number: number;
  title: string;
  state: "open" | "closed";
  verdict: string | null;
  url: string;
  /** ISO date the issue last changed (GitHub's `updated_at`). */
  updatedAt: string | null;
}

interface TagReviewState {
  state: "open" | "closed";
  verdict: string | null;
}

/** The cursor: the last state+verdict pair seen per issue number. */
export type TagReviewIndex = Record<number, TagReviewState>;

const SOURCE_ID = "tag-reviews";

const verdictLabel = (review: TagReview): string => (review.verdict ? ` (${review.verdict})` : "");

const reviewTitle = (review: TagReview, state: "open" | "closed"): string => {
  const action = state === "open" ? "opened" : "closed";
  return `TAG design review ${action}: ${review.title}${state === "closed" ? verdictLabel(review) : ""}`;
};

export const deriveTagReviewIndex = (reviews: TagReview[]): TagReviewIndex => {
  const index: TagReviewIndex = {};
  for (const review of reviews) {
    index[review.number] = { state: review.state, verdict: review.verdict };
  }
  return index;
};

const verdictSlug = (verdict: string | null): string =>
  verdict === null
    ? "none"
    : verdict
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");

const reviewCandidate = (
  review: TagReview,
  before: TagReviewState | null,
  observedAt: string,
): CandidateEvent => {
  const title = reviewTitle(review, review.state);
  // Keyed by transition (state plus verdict), not just the destination
  // state: a review can close, reopen, and close again with a different
  // verdict, and a destination-only key would collide with the earlier
  // event's dedupe_key and swallow this one.
  const transition = `${before?.state ?? "unseen"}-${verdictSlug(before?.verdict ?? null)}-to-${review.state}-${verdictSlug(review.verdict)}`;
  return {
    type: "tag-review",
    subject: { kind: "tag-review", number: review.number },
    title,
    before: before === null ? null : { state: before.state, verdict: before.verdict },
    after: { state: review.state, verdict: review.verdict, url: review.url },
    occurredAt: review.updatedAt,
    taxonomy: ["api"],
    dedupeKey: `tag-reviews:review:${review.number}:${transition}`,
    correlationKey: `tag-review:${review.number}:${transition}`,
    provenance: [{ sourceId: SOURCE_ID, url: review.url, title, observedAt }],
  };
};

/**
 * Cold start (§5.3): the first run has no cursor to diff against, so it
 * seeds every known review's state and verdict silently — no events,
 * since there is no dated window to replay — and events flow from the
 * next state or verdict change on.
 */
export const diffTagReviews = (
  prev: TagReviewIndex | null,
  reviews: TagReview[],
  options: { observedAt: string },
): CandidateEvent[] => {
  if (prev === null) return [];

  const events: CandidateEvent[] = [];
  for (const review of reviews) {
    const before = prev[review.number] ?? null;
    // Label churn (Progress:, Focus:, etc.) and comments never reach this
    // diff — the adapter only carries state and the Resolution: verdict,
    // so anything that did not move one of those two fields is silent.
    if (before !== null && before.state === review.state && before.verdict === review.verdict) {
      continue;
    }
    events.push(reviewCandidate(review, before, options.observedAt));
  }
  return events;
};
