import { describe, expect, it } from "vite-plus/test";
import type { DigestView } from "../core/digest.ts";
import type { ChangeEvent } from "../core/types.ts";
import { renderDigestEmail } from "./email.ts";

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
  provenance: [
    {
      sourceId: "web-features",
      url: `https://webstatus.dev/features/${id}`,
      title: id,
      observedAt: "2026-06-10T00:00:00Z",
    },
  ],
  significance: 0.5,
  firstObservedAt: "2026-06-10T00:00:00Z",
  lastUpdatedAt: "2026-06-10T00:00:00Z",
  ...overrides,
});

const digest = (items: ChangeEvent[]): DigestView => ({
  id: "digest-1",
  cadence: "daily",
  windowStart: "2026-06-09T12:00:00Z",
  windowEnd: "2026-06-10T12:00:00Z",
  items,
});

describe("renderDigestEmail", () => {
  it("counts the changes in the subject", () => {
    expect(renderDigestEmail(digest([event("lh", {})])).subject).toBe("Platform Pulse — 1 change");
    expect(renderDigestEmail(digest([event("a", {}), event("b", {})])).subject).toBe(
      "Platform Pulse — 2 changes",
    );
  });

  it("renders every item with its provenance links, in digest order", () => {
    const { html, text } = renderDigestEmail(
      digest([
        event("lh", { title: "lh is now Baseline widely available" }),
        event("style-queries", { title: "Style queries is now Baseline newly available" }),
      ]),
    );

    expect(html.indexOf("lh is now")).toBeGreaterThan(-1);
    expect(html.indexOf("lh is now")).toBeLessThan(html.indexOf("Style queries is now"));
    expect(html).toContain('href="https://webstatus.dev/features/lh"');
    expect(html).toContain('href="https://webstatus.dev/features/style-queries"');

    expect(text).toContain("lh is now Baseline widely available");
    expect(text).toContain("https://webstatus.dev/features/style-queries");
  });

  it("escapes markup in titles so content cannot inject HTML", () => {
    const { html } = renderDigestEmail(
      digest([event("x", { title: 'selector <script>"&"</script>' })]),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("selector &lt;script&gt;&quot;&amp;&quot;&lt;/script&gt;");
  });
});
