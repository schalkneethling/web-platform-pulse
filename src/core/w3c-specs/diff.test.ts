import { describe, expect, it } from "vite-plus/test";
import { deriveW3CSpecIndex, diffW3CSpecs, type W3CSpec } from "./diff.ts";

const spec = (overrides: Partial<W3CSpec>): W3CSpec => ({
  shortname: "css-color-5",
  title: "CSS Color Module Level 5",
  status: "Working Draft",
  date: "2026-06-18",
  url: "https://www.w3.org/TR/2026/WD-css-color-5-20260618/",
  groups: ["Cascading Style Sheets (CSS) Working Group"],
  editors: ["Chris Lilley", "Una Kravets", "Lea Verou"],
  ...overrides,
});

const OBSERVED_AT = "2026-07-10T12:00:00.000Z";
const diff = (prev: Record<string, string> | null, specs: W3CSpec[]) =>
  diffW3CSpecs(prev, specs, { observedAt: OBSERVED_AT });

describe("deriveW3CSpecIndex", () => {
  it("keys the last seen status by shortname", () => {
    expect(
      deriveW3CSpecIndex([spec({}), spec({ shortname: "css-color-4", status: "Recommendation" })]),
    ).toEqual({ "css-color-5": "Working Draft", "css-color-4": "Recommendation" });
  });
});

describe("diffW3CSpecs", () => {
  it("seeds silently on cold start — no dated window to replay (§5.3)", () => {
    expect(diff(null, [spec({})])).toEqual([]);
  });

  it("emits a spec-change event when a spec's status advances, keeping both states", () => {
    const events = diff({ "css-color-5": "First Public Working Draft" }, [spec({})]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "spec-change",
      subject: { kind: "spec", shortname: "css-color-5" },
      title:
        "CSS Color Module Level 5 advanced to Working Draft (Cascading Style Sheets (CSS) " +
        "Working Group; edited by Chris Lilley, Una Kravets, Lea Verou)",
      before: { status: "First Public Working Draft" },
      after: {
        status: "Working Draft",
        groups: ["Cascading Style Sheets (CSS) Working Group"],
        editors: ["Chris Lilley", "Una Kravets", "Lea Verou"],
        specUrl: "https://www.w3.org/TR/2026/WD-css-color-5-20260618/",
      },
      occurredAt: "2026-06-18",
      taxonomy: ["css"],
      dedupeKey: "w3c-specs:spec:css-color-5:first-public-working-draft-to-working-draft",
      correlationKey: "spec-change:css-color-5:first-public-working-draft-to-working-draft",
    });
    expect(events[0]?.provenance[0]).toMatchObject({
      sourceId: "w3c-specs",
      url: "https://www.w3.org/TR/2026/WD-css-color-5-20260618/",
      observedAt: OBSERVED_AT,
    });
  });

  it("abbreviates both Candidate Recommendation stages to CR in the digest line", () => {
    const draft = diff({}, [spec({ status: "Candidate Recommendation Draft" })])[0];
    const snapshot = diff({}, [spec({ status: "Candidate Recommendation Snapshot" })])[0];
    expect(draft?.title).toContain("advanced to CR (");
    expect(snapshot?.title).toContain("advanced to CR (");
  });

  it("emits a spec unseen by the cursor as before: null", () => {
    const events = diff({}, [spec({ status: "Recommendation" })]);
    expect(events[0]).toMatchObject({ before: null });
  });

  it("stays silent while a spec's status is unchanged", () => {
    expect(diff({ "css-color-5": "Working Draft" }, [spec({})])).toEqual([]);
  });

  it("keys by transition, so a revisited status is a fresh event", () => {
    const firstCr = diff({ "css-color-4": "Working Draft" }, [
      spec({ shortname: "css-color-4", status: "Candidate Recommendation Draft" }),
    ]);
    const secondCr = diff({ "css-color-4": "Candidate Recommendation Snapshot" }, [
      spec({ shortname: "css-color-4", status: "Candidate Recommendation Draft" }),
    ]);
    expect(firstCr[0]?.dedupeKey).not.toBe(secondCr[0]?.dedupeKey);
    expect(firstCr[0]?.correlationKey).not.toBe(secondCr[0]?.correlationKey);
  });

  it("derives theme from working-group names, falling back to api", () => {
    const html = diff({}, [
      spec({ shortname: "service-workers", groups: ["Web Applications Working Group"] }),
    ])[0];
    const other = diff({}, [
      spec({ shortname: "wot-discovery", groups: ["Web of Things Working Group"] }),
    ])[0];
    expect(html?.taxonomy).toEqual(["html"]);
    expect(other?.taxonomy).toEqual(["api"]);
  });

  it("omits the attribution suffix when groups and editors are both unknown", () => {
    const events = diff({}, [spec({ groups: [], editors: [] })]);
    expect(events[0]?.title).toBe("CSS Color Module Level 5 advanced to Working Draft");
  });

  it("still attributes the working group when editors are unknown", () => {
    const events = diff({}, [spec({ editors: [] })]);
    expect(events[0]?.title).toBe(
      "CSS Color Module Level 5 advanced to Working Draft (Cascading Style Sheets (CSS) Working Group)",
    );
  });
});
