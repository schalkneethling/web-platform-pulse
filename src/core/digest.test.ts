import { describe, expect, it } from "vite-plus/test";
import { orderForDigest } from "./digest.ts";
import type { ChangeEvent } from "./types.ts";

const event = (id: string, overrides: Partial<ChangeEvent>): ChangeEvent => ({
  id,
  type: "baseline-change",
  subject: { kind: "feature", id },
  title: id,
  before: null,
  after: { baseline: "low" },
  occurredAt: null,
  taxonomy: ["css"],
  dedupeKey: `k:${id}`,
  correlationKey: `c:${id}`,
  provenance: [],
  significance: 0.5,
  firstObservedAt: "2026-06-10T00:00:00Z",
  lastUpdatedAt: "2026-06-10T00:00:00Z",
  ...overrides,
});

describe("orderForDigest", () => {
  it("groups events by theme and ranks by significance within a group (§9)", () => {
    const ordered = orderForDigest([
      event("css-minor", { taxonomy: ["css"], significance: 0.4 }),
      event("node-release", {
        type: "runtime-release",
        subject: { kind: "runtime", name: "node", version: "25.0.0" },
        taxonomy: ["runtime", "node"],
        significance: 0.8,
      }),
      event("css-major", { taxonomy: ["css"], significance: 0.9 }),
    ]);
    expect(ordered.map((e) => e.id)).toEqual(["css-major", "css-minor", "node-release"]);
  });

  it("is deterministic for equal significance", () => {
    const events = [event("b", { significance: 0.5 }), event("a", { significance: 0.5 })];
    expect(orderForDigest(events).map((e) => e.id)).toEqual(["a", "b"]);
    expect(orderForDigest([...events].reverse()).map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("returns an empty list for no events", () => {
    expect(orderForDigest([])).toEqual([]);
  });
});
