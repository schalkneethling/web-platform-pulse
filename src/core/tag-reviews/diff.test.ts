import { describe, expect, it } from "vite-plus/test";
import { deriveTagReviewIndex, diffTagReviews, type TagReview } from "./diff.ts";

const review = (overrides: Partial<TagReview>): TagReview => ({
  number: 1244,
  title: "Web Application Security Working Group Charter",
  state: "open",
  verdict: null,
  url: "https://github.com/w3ctag/design-reviews/issues/1244",
  updatedAt: "2026-06-18",
  ...overrides,
});

const OBSERVED_AT = "2026-07-10T12:00:00.000Z";
const diff = (prev: ReturnType<typeof deriveTagReviewIndex> | null, reviews: TagReview[]) =>
  diffTagReviews(prev, reviews, { observedAt: OBSERVED_AT });

describe("deriveTagReviewIndex", () => {
  it("keys the last seen state and verdict by issue number", () => {
    expect(
      deriveTagReviewIndex([
        review({}),
        review({ number: 1230, state: "closed", verdict: "satisfied" }),
      ]),
    ).toEqual({
      1244: { state: "open", verdict: null },
      1230: { state: "closed", verdict: "satisfied" },
    });
  });
});

describe("diffTagReviews", () => {
  it("seeds silently on cold start — no dated window to replay (§5.3)", () => {
    expect(diff(null, [review({})])).toEqual([]);
  });

  it("emits an opened event for a review unseen by the cursor", () => {
    const events = diff({}, [review({})]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tag-review",
      subject: { kind: "tag-review", number: 1244 },
      title: "TAG design review opened: Web Application Security Working Group Charter",
      before: null,
      after: {
        state: "open",
        verdict: null,
        url: "https://github.com/w3ctag/design-reviews/issues/1244",
      },
      occurredAt: "2026-06-18",
      taxonomy: ["api"],
    });
    expect(events[0]?.provenance[0]).toMatchObject({
      sourceId: "tag-reviews",
      url: "https://github.com/w3ctag/design-reviews/issues/1244",
      observedAt: OBSERVED_AT,
    });
  });

  it("emits a closed event with verdict when the TAG resolves a review", () => {
    const events = diff({ 1244: { state: "open", verdict: null } }, [
      review({ state: "closed", verdict: "satisfied", updatedAt: "2026-07-08" }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      title: "TAG design review closed: Web Application Security Working Group Charter (satisfied)",
      before: { state: "open", verdict: null },
      after: { state: "closed", verdict: "satisfied" },
      occurredAt: "2026-07-08",
    });
  });

  it("emits a fresh event when a closed review's verdict changes without reopening", () => {
    // The TAG occasionally revises a resolution label after closing.
    const events = diff({ 1244: { state: "closed", verdict: "satisfied with concerns" } }, [
      review({ state: "closed", verdict: "satisfied" }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      before: { state: "closed", verdict: "satisfied with concerns" },
      after: { state: "closed", verdict: "satisfied" },
    });
  });

  it("emits a reopened event when a closed review reopens", () => {
    const events = diff({ 1244: { state: "closed", verdict: "unsatisfied" } }, [
      review({ state: "open", verdict: null }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      title: "TAG design review opened: Web Application Security Working Group Charter",
      before: { state: "closed", verdict: "unsatisfied" },
      after: { state: "open", verdict: null },
    });
  });

  it("stays silent while state and verdict are both unchanged (label churn, comments)", () => {
    expect(diff({ 1244: { state: "open", verdict: null } }, [review({})])).toEqual([]);
    expect(
      diff({ 1244: { state: "closed", verdict: "satisfied" } }, [
        review({ state: "closed", verdict: "satisfied" }),
      ]),
    ).toEqual([]);
  });

  it("gives two occurrences of the same transition distinct keys via the review number", () => {
    const first = diff({}, [review({ number: 1, state: "closed", verdict: "satisfied" })]);
    const second = diff({}, [review({ number: 2, state: "closed", verdict: "satisfied" })]);
    expect(first[0]?.dedupeKey).not.toBe(second[0]?.dedupeKey);
    expect(first[0]?.correlationKey).not.toBe(second[0]?.correlationKey);
  });

  it("keys by transition, so open-close-reopen-close is four distinct dedupe keys", () => {
    const opened = diff({}, [review({ state: "open", verdict: null })]);
    const closed = diff({ 1244: { state: "open", verdict: null } }, [
      review({ state: "closed", verdict: "satisfied" }),
    ]);
    const reopened = diff({ 1244: { state: "closed", verdict: "satisfied" } }, [
      review({ state: "open", verdict: null }),
    ]);
    const closedAgain = diff({ 1244: { state: "open", verdict: null } }, [
      review({ state: "closed", verdict: "unsatisfied" }),
    ]);
    const keys = [opened, closed, reopened, closedAgain].map((events) => events[0]?.dedupeKey);
    expect(new Set(keys).size).toBe(4);
  });

  it("is idempotent: re-running with unchanged data after a seed produces zero events", () => {
    const seeded = deriveTagReviewIndex([review({ state: "closed", verdict: "satisfied" })]);
    expect(diff(seeded, [review({ state: "closed", verdict: "satisfied" })])).toEqual([]);
  });

  it("omits the verdict suffix in the title when a closed review carries no Resolution label", () => {
    const events = diff({ 1244: { state: "open", verdict: null } }, [
      review({ state: "closed", verdict: null }),
    ]);
    expect(events[0]?.title).toBe(
      "TAG design review closed: Web Application Security Working Group Charter",
    );
  });
});
