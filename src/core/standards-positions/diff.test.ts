import { describe, expect, it } from "vite-plus/test";
import { derivePositionIndex, diffVendorPositions, type VendorPosition } from "./diff.ts";

const position = (overrides: Partial<VendorPosition>): VendorPosition => ({
  vendor: "mozilla",
  key: "20",
  position: "positive",
  title: "Trusted Types",
  specUrl: "https://w3c.github.io/trusted-types/dist/spec/",
  issueUrl: "https://github.com/mozilla/standards-positions/issues/20",
  topics: ["API"],
  ...overrides,
});

const OBSERVED_AT = "2026-06-10T12:00:00.000Z";
const diff = (prev: Record<string, string> | null, positions: VendorPosition[]) =>
  diffVendorPositions(prev, positions, { observedAt: OBSERVED_AT });

describe("derivePositionIndex", () => {
  it("keys by vendor and issue, recording missing positions as none", () => {
    expect(
      derivePositionIndex([
        position({}),
        position({ vendor: "webkit", key: "77", position: null }),
      ]),
    ).toEqual({ "mozilla:20": "positive", "webkit:77": "none" });
  });
});

describe("diffVendorPositions", () => {
  it("seeds silently on cold start — the artifacts carry no dates to window (§5.3)", () => {
    expect(diff(null, [position({})])).toEqual([]);
  });

  it("emits when a vendor revises a position, keeping both stances", () => {
    const events = diff({ "mozilla:20": "neutral" }, [position({})]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "vendor-position",
      subject: { kind: "spec", shortname: "w3c.github.io/trusted-types/dist/spec" },
      title: "Mozilla is positive on Trusted Types",
      before: { position: "neutral" },
      after: { position: "positive", specUrl: "https://w3c.github.io/trusted-types/dist/spec/" },
      taxonomy: ["api"],
      dedupeKey: "standards-positions:position:mozilla:20:positive",
      correlationKey: "vendor-position:mozilla:20:positive",
    });
    expect(events[0]?.provenance[0]).toMatchObject({
      sourceId: "standards-positions",
      url: "https://github.com/mozilla/standards-positions/issues/20",
      observedAt: OBSERVED_AT,
    });
  });

  it("treats a first position on a pending request as before: null", () => {
    const events = diff({ "webkit:77": "none" }, [
      position({
        vendor: "webkit",
        key: "77",
        position: "support",
        title: "CSS Anchor Positioning",
        topics: ["css"],
      }),
    ]);
    expect(events[0]).toMatchObject({
      title: "WebKit supports CSS Anchor Positioning",
      before: null,
      taxonomy: ["css"],
    });
  });

  it("emits a proposal unseen by the cursor once it carries a position", () => {
    const events = diff({}, [position({ position: "negative", title: "Topics API", topics: [] })]);
    expect(events[0]).toMatchObject({
      title: "Mozilla is negative on Topics API",
      before: null,
      taxonomy: ["api"],
    });
  });

  it("stays silent for unchanged, pending, and withdrawn positions", () => {
    const events = diff({ "mozilla:20": "positive", "webkit:77": "support" }, [
      position({}),
      position({ vendor: "webkit", key: "77", position: null }),
      position({ vendor: "mozilla", key: "1104", position: null }),
    ]);
    expect(events).toEqual([]);
  });

  it("phrases each vendor's vocabulary and falls back for new ones", () => {
    const title = (vendor: VendorPosition["vendor"], taken: string) =>
      diff({}, [position({ vendor, key: "9", position: taken, title: "X" })])[0]?.title;
    expect(title("mozilla", "defer")).toBe("Mozilla defers on X");
    expect(title("mozilla", "neutral")).toBe("Mozilla is neutral on X");
    expect(title("webkit", "oppose")).toBe("WebKit opposes X");
    expect(title("webkit", "blocked")).toBe("WebKit's review of X is blocked");
    expect(title("webkit", "delighted")).toBe("WebKit position on X: delighted");
  });

  it("falls back to the issue URL for a subject when the spec URL is missing", () => {
    const events = diff({}, [position({ specUrl: null })]);
    expect(events[0]?.subject).toEqual({
      kind: "spec",
      shortname: "github.com/mozilla/standards-positions/issues/20",
    });
  });
});
