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

  it("ranks browser releases major above patch, neutral when unversioned", () => {
    const browserRelease = (before: unknown, after: unknown) =>
      scoreSignificance(
        candidate({
          type: "browser-release",
          subject: { kind: "browser", name: "chrome", version: "149.0.7827.201" },
          before,
          after,
        }),
      );
    const major = browserRelease(
      { version: "148.0.7800.100", channel: "stable" },
      { version: "149.0.7827.201", channel: "stable" },
    );
    const patch = browserRelease(
      { version: "149.0.7827.200", channel: "stable" },
      { version: "149.0.7827.201", channel: "stable" },
    );
    const unknown = browserRelease(null, { version: "149.0.7827.201", channel: "stable" });
    expect(major).toBeGreaterThan(unknown);
    expect(unknown).toBeGreaterThan(patch);
  });

  it("sinks pre-release channels below every stable release", () => {
    const channelRelease = (channel: string) =>
      scoreSignificance(
        candidate({
          type: "browser-release",
          subject: { kind: "browser", name: "chrome", version: "150.0.1" },
          before: null,
          after: { version: "150.0.1", channel },
        }),
      );
    const stablePatch = scoreSignificance(
      candidate({
        type: "browser-release",
        subject: { kind: "browser", name: "chrome", version: "149.0.7827.201" },
        before: { version: "149.0.7827.200", channel: "stable" },
        after: { version: "149.0.7827.201", channel: "stable" },
      }),
    );
    for (const channel of ["beta", "preview"]) {
      expect(channelRelease(channel)).toBeLessThan(stablePatch);
    }
    for (const channel of ["dev", "canary", "nightly"]) {
      expect(channelRelease(channel)).toBeLessThan(channelRelease("beta"));
    }
  });

  it("ranks vendor opposition above endorsement above hedged positions", () => {
    const vendorPosition = (taken: string) =>
      scoreSignificance(
        candidate({
          type: "vendor-position",
          subject: { kind: "spec", shortname: "x" },
          after: { position: taken },
        }),
      );
    expect(vendorPosition("oppose")).toBeGreaterThan(vendorPosition("support"));
    expect(vendorPosition("negative")).toBeGreaterThan(vendorPosition("positive"));
    expect(vendorPosition("support")).toBeGreaterThan(vendorPosition("neutral"));
    expect(vendorPosition("defer")).toBe(vendorPosition("blocked"));
  });

  it("ranks Chrome breaking changes above shipping above trials above paperwork", () => {
    const featureStatus = (status: string) =>
      scoreSignificance(
        candidate({
          type: "feature-status",
          subject: { kind: "feature", id: "x" },
          after: { status },
        }),
      );
    expect(featureStatus("Deprecated")).toBeGreaterThan(featureStatus("Enabled by default"));
    expect(featureStatus("Enabled by default")).toBeGreaterThan(featureStatus("Origin trial"));
    expect(featureStatus("Origin trial")).toBeGreaterThan(
      featureStatus("In developer trial (Behind a flag)"),
    );
    expect(featureStatus("Proposed")).toBe(featureStatus("In development"));
  });

  it("ranks a contested TAG verdict above a routine one above an opened review", () => {
    const tagReview = (state: string, verdict: string | null) =>
      scoreSignificance(
        candidate({
          type: "tag-review",
          subject: { kind: "tag-review", number: 1244 },
          after: { state, verdict },
        }),
      );
    expect(tagReview("closed", "unsatisfied")).toBeGreaterThan(tagReview("closed", "satisfied"));
    expect(tagReview("closed", "satisfied")).toBeGreaterThan(tagReview("open", null));
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
      candidate({ type: "browser-release", after: { version: "not-semver" } }),
      candidate({
        type: "runtime-release",
        subject: { kind: "runtime", name: "bun", version: "nightly" },
      }),
      candidate({
        type: "tag-review",
        subject: { kind: "tag-review", number: 1 },
        after: { state: "closed", verdict: "unsatisfied" },
      }),
    ]) {
      const score = scoreSignificance(event);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});
