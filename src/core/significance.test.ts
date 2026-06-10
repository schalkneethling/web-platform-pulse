import { describe, expect, it } from "vite-plus/test";
import { scoreSignificance } from "./significance.ts";
import type { CandidateEvent } from "./types.ts";

const candidate = (overrides: Partial<CandidateEvent>): CandidateEvent => ({
  type: "baseline-change",
  subject: { kind: "feature", id: "x" },
  title: "x",
  before: null,
  after: { baseline: "low" },
  occurredAt: null,
  taxonomy: ["css"],
  dedupeKey: "k",
  correlationKey: "c",
  provenance: [],
  ...overrides,
});

describe("scoreSignificance", () => {
  it("ranks widely available above newly available above browser support (§8.3)", () => {
    const high = scoreSignificance(candidate({ after: { baseline: "high" } }));
    const low = scoreSignificance(candidate({ after: { baseline: "low" } }));
    const support = scoreSignificance(
      candidate({ type: "browser-support", after: { browser: "safari", version: "7" } }),
    );
    expect(high).toBeGreaterThan(low);
    expect(low).toBeGreaterThan(support);
  });

  it("ranks runtime releases major above minor above patch", () => {
    const release = (version: string) =>
      scoreSignificance(
        candidate({
          type: "runtime-release",
          subject: { kind: "runtime", name: "node", version },
        }),
      );
    expect(release("25.0.0")).toBeGreaterThan(release("25.1.0"));
    expect(release("25.1.0")).toBeGreaterThan(release("25.1.1"));
  });

  it("always returns a value in [0, 1]", () => {
    for (const event of [
      candidate({}),
      candidate({ type: "spec-change" }),
      candidate({ type: "editorial" }),
      candidate({
        type: "runtime-release",
        subject: { kind: "runtime", name: "bun", version: "nightly" },
      }),
    ]) {
      const score = scoreSignificance(event);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});
