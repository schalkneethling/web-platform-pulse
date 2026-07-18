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

  it("groups items under theme headings in digest order", () => {
    const { html, text } = renderDigestEmail(
      digest([
        event("lh", { taxonomy: ["css"] }),
        event("chrome", {
          type: "browser-release",
          title: "Chrome Canary 152.0.7925.0 released",
          taxonomy: ["browser"],
        }),
      ]),
    );

    expect(html.indexOf("<h2>CSS</h2>")).toBeGreaterThan(-1);
    expect(html.indexOf("<h2>CSS</h2>")).toBeLessThan(html.indexOf("<h2>Browser Releases</h2>"));
    expect(html.indexOf("<h2>Browser Releases</h2>")).toBeLessThan(
      html.indexOf("Chrome Canary 152.0.7925.0 released"),
    );
    expect(text).toContain("# Browser Releases");
  });

  it("shows the covered window, change dates, and source-titled links", () => {
    const { html, text } = renderDigestEmail(
      digest([
        event("lh", {
          title: "lh is now Baseline widely available",
          occurredAt: "2026-05-21",
          provenance: [
            {
              sourceId: "web-features",
              url: "https://webstatus.dev/features/lh",
              title: "lh unit",
              observedAt: "2026-06-10T00:00:00Z",
            },
          ],
        }),
      ]),
    );

    expect(html).toContain("covering 9 June 2026 to 10 June 2026");
    expect(html).toContain("Changed on 21 May 2026");
    expect(html).toContain('<a href="https://webstatus.dev/features/lh">lh unit</a>');
    expect(text).toContain("Changed on 21 May 2026");
  });

  it("rolls browser-support items into one prose sentence with feature links", () => {
    const support = (featureId: string, name: string, browser: string): ChangeEvent =>
      event(`${featureId}:${browser}`, {
        type: "browser-support",
        subject: { kind: "feature", id: featureId },
        title: `${browser} 150 supports ${name}`,
        after: { browser, version: "150" },
        provenance: [
          {
            sourceId: "web-features",
            url: `https://webstatus.dev/features/${featureId}`,
            title: name,
            observedAt: "2026-07-15T00:00:00Z",
          },
        ],
      });

    const { html, text } = renderDigestEmail(
      digest([
        event("lh", { title: "lh is now Baseline widely available" }),
        support("text-fit", "text-fit", "chrome"),
        support("text-fit", "text-fit", "edge"),
        support("light-dark-image", "light-dark() image values", "chrome"),
        support("light-dark-image", "light-dark() image values", "edge"),
      ]),
    );

    expect(html).not.toContain("chrome 150 supports");
    expect(html).toContain(
      '<p>Chrome and Edge 150 now support <a href="https://webstatus.dev/features/light-dark-image">light-dark() image values</a> and <a href="https://webstatus.dev/features/text-fit">text-fit</a>.</p>',
    );
    expect(html).toContain("lh is now Baseline widely available");

    expect(text).toContain(
      "- Chrome and Edge 150 now support light-dark() image values and text-fit.",
    );
    expect(text).toContain("  https://webstatus.dev/features/text-fit");
  });

  it("escapes markup in titles so content cannot inject HTML", () => {
    const { html } = renderDigestEmail(
      digest([event("x", { title: 'selector <script>"&"</script>' })]),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("selector &lt;script&gt;&quot;&amp;&quot;&lt;/script&gt;");
  });
});
