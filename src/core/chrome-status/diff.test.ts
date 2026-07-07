import { describe, expect, it } from "vite-plus/test";
import { deriveChromeStatusIndex, diffChromeStatus, type ChromeFeature } from "./diff.ts";

const feature = (overrides: Partial<ChromeFeature>): ChromeFeature => ({
  id: "5144822362931200",
  name: "CSS anchor positioning",
  status: "Enabled by default",
  milestone: "125",
  webFeature: "anchor-positioning",
  specUrl: "https://drafts.csswg.org/css-anchor-position-1/",
  category: "CSS",
  ...overrides,
});

const OBSERVED_AT = "2026-07-07T12:00:00.000Z";
const diff = (prev: Record<string, string> | null, features: ChromeFeature[]) =>
  diffChromeStatus(prev, features, { observedAt: OBSERVED_AT });

describe("deriveChromeStatusIndex", () => {
  it("keys the last seen status by feature id", () => {
    expect(
      deriveChromeStatusIndex([feature({}), feature({ id: "9", status: "Proposed" })]),
    ).toEqual({ "5144822362931200": "Enabled by default", "9": "Proposed" });
  });
});

describe("diffChromeStatus", () => {
  it("seeds silently on cold start — dump timestamps are edits, not transitions (§5.3)", () => {
    expect(diff(null, [feature({})])).toEqual([]);
  });

  it("emits when a feature's Chrome status changes, keeping both states", () => {
    const events = diff({ "5144822362931200": "Origin trial" }, [feature({})]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "feature-status",
      subject: { kind: "feature", id: "anchor-positioning" },
      title: "CSS anchor positioning shipped in Chrome 125",
      before: { status: "Origin trial" },
      after: {
        status: "Enabled by default",
        milestone: "125",
        specUrl: "https://drafts.csswg.org/css-anchor-position-1/",
      },
      taxonomy: ["css"],
      dedupeKey: "chrome-status:feature:5144822362931200:enabled-by-default",
      correlationKey: "feature-status:chrome:5144822362931200:enabled-by-default",
    });
    expect(events[0]?.provenance[0]).toMatchObject({
      sourceId: "chrome-status",
      url: "https://chromestatus.com/feature/5144822362931200",
      observedAt: OBSERVED_AT,
    });
  });

  it("emits a feature unseen by the cursor as before: null", () => {
    const events = diff({}, [
      feature({ id: "7", status: "Origin trial", milestone: "126", category: "DOM" }),
    ]);
    expect(events[0]).toMatchObject({
      title: "CSS anchor positioning entered origin trial in Chrome 126",
      before: null,
      taxonomy: ["api"],
    });
  });

  it("stays silent while a feature's status is unchanged", () => {
    expect(diff({ "5144822362931200": "Enabled by default" }, [feature({})])).toEqual([]);
  });

  it("falls back to a chromestatus subject when no web-features id is mapped", () => {
    const events = diff({}, [feature({ webFeature: null })]);
    expect(events[0]?.subject).toEqual({ kind: "feature", id: "chromestatus/5144822362931200" });
  });

  it("phrases the status vocabulary and falls back for new entries", () => {
    const title = (status: string, milestone: string | null = "130") =>
      diff({}, [feature({ status, milestone, name: "X" })])[0]?.title;
    expect(title("Deprecated")).toBe("X deprecated in Chrome 130");
    expect(title("Removed")).toBe("X removed from Chrome 130");
    expect(title("In developer trial (Behind a flag)")).toBe(
      "X available behind a flag in Chrome 130",
    );
    expect(title("Proposed", null)).toBe("X proposed for Chrome");
    expect(title("In development", null)).toBe("X in development for Chrome");
    expect(title("Enabled by default", null)).toBe("X shipped in Chrome");
    expect(title("On hold", null)).toBe("Chrome status for X: On hold");
  });
});
