import { describe, expect, it } from "vite-plus/test";
import { THEME_ITEM_CAP, type DigestView } from "../core/digest.ts";
import type { ChangeEvent } from "../core/types.ts";
import { createEmailChannel, renderDigestEmail, type EmailMessage } from "./email.ts";

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

const UNSUBSCRIBE = "https://pulse.example.com/unsubscribe?token=tok-1";

const digest = (items: ChangeEvent[]): DigestView => ({
  id: "digest-1",
  cadence: "daily",
  windowStart: "2026-06-09T12:00:00Z",
  windowEnd: "2026-06-10T12:00:00Z",
  items,
});

describe("renderDigestEmail", () => {
  it("counts the changes in the subject", () => {
    expect(renderDigestEmail(digest([event("lh", {})]), UNSUBSCRIBE).subject).toBe(
      "Platform Pulse — 1 change",
    );
    expect(renderDigestEmail(digest([event("a", {}), event("b", {})]), UNSUBSCRIBE).subject).toBe(
      "Platform Pulse — 2 changes",
    );
  });

  it("renders every item with its provenance links, in digest order", () => {
    const { html, text } = renderDigestEmail(
      digest([
        event("lh", { title: "lh is now Baseline widely available" }),
        event("style-queries", { title: "Style queries is now Baseline newly available" }),
      ]),
      UNSUBSCRIBE,
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
      UNSUBSCRIBE,
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
      UNSUBSCRIBE,
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
      UNSUBSCRIBE,
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
      UNSUBSCRIBE,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("selector &lt;script&gt;&quot;&amp;&quot;&lt;/script&gt;");
  });

  it("ends both bodies with a link to the recipient's unsubscribe page", () => {
    const { html, text } = renderDigestEmail(digest([event("lh", {})]), UNSUBSCRIBE);

    expect(html).toContain(`<a href="${UNSUBSCRIBE}">Unsubscribe</a>`);
    expect(html.indexOf("Unsubscribe")).toBeGreaterThan(html.indexOf("lh"));
    expect(text).toContain(`Unsubscribe from Platform Pulse: ${UNSUBSCRIBE}`);
    expect(text.trimEnd().endsWith(UNSUBSCRIBE)).toBe(true);
  });

  it("escapes the unsubscribe link in the HTML body", () => {
    const { html } = renderDigestEmail(digest([event("lh", {})]), 'https://x.test/u?a=1&b="2"');
    expect(html).toContain('href="https://x.test/u?a=1&amp;b=&quot;2&quot;"');
  });

  describe("folding", () => {
    const themeItems = (count: number): ChangeEvent[] =>
      Array.from({ length: count }, (_, i) =>
        event(`css-${i}`, { title: `css item ${i}`, significance: 1 - i * 0.01 }),
      );

    it("folds a theme over the cap to the cap's worth, with an overflow line", () => {
      const items = themeItems(THEME_ITEM_CAP + 3);
      const { html, text } = renderDigestEmail(digest(items), UNSUBSCRIBE);

      for (const item of items.slice(0, THEME_ITEM_CAP)) {
        expect(html).toContain(item.title);
        expect(text).toContain(item.title);
      }
      expect(html).toContain("  <p>+3 more</p>");
      expect(text).toContain("+3 more");
    });

    it("does not render the titles of folded items", () => {
      const items = themeItems(THEME_ITEM_CAP + 3);
      const { html, text } = renderDigestEmail(digest(items), UNSUBSCRIBE);

      for (const item of items.slice(THEME_ITEM_CAP)) {
        expect(html).not.toContain(item.title);
        expect(text).not.toContain(item.title);
      }
    });

    it("renders every item and no overflow line for a theme at or under the cap", () => {
      const atCap = themeItems(THEME_ITEM_CAP);
      const underCap = themeItems(THEME_ITEM_CAP - 1);

      for (const items of [atCap, underCap]) {
        const { html, text } = renderDigestEmail(digest(items), UNSUBSCRIBE);
        for (const item of items) {
          expect(html).toContain(item.title);
          expect(text).toContain(item.title);
        }
        expect(html).not.toMatch(/\+\d+ more/);
        expect(text).not.toMatch(/^\+\d+ more$/m);
      }
    });

    it("renders a rollup whole even when the theme's plain items overflow", () => {
      const support = (browser: string, version: string): ChangeEvent =>
        event(`text-fit:${browser}`, {
          type: "browser-support",
          subject: { kind: "feature", id: "text-fit" },
          title: `${browser} ${version} supports text-fit`,
          after: { browser, version },
          provenance: [
            {
              sourceId: "web-features",
              url: "https://webstatus.dev/features/text-fit",
              title: "text-fit",
              observedAt: "2026-07-15T00:00:00Z",
            },
          ],
        });

      const rest = themeItems(THEME_ITEM_CAP + 3);
      const rollupEvents = [support("chrome", "150"), support("edge", "150")];
      const { html, text } = renderDigestEmail(digest([...rest, ...rollupEvents]), UNSUBSCRIBE);

      // Rollups are exempt from the cap, so the sentence survives intact even
      // though three plain items in the same theme were folded away.
      expect(html).toContain(
        '<p>Chrome and Edge 150 now support <a href="https://webstatus.dev/features/text-fit">text-fit</a>.</p>',
      );
      expect(text).toContain("- Chrome and Edge 150 now support text-fit.");
      expect(html).toContain("  <p>+3 more</p>");
      expect(text).toContain("+3 more");
    });
  });
});

describe("createEmailChannel", () => {
  const sentThrough = async (token: string): Promise<EmailMessage> => {
    const sent: EmailMessage[] = [];
    const channel = createEmailChannel({
      from: "Platform Pulse <pulse@localhost>",
      publicUrl: "https://pulse.example.com",
      send: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
    });
    const result = await channel.send(digest([event("lh", {})]), {
      email: "reader@example.com",
      unsubscribeToken: token,
    });
    expect(result).toEqual({ status: "sent" });
    return sent[0]!;
  };

  it("links each recipient's own unsubscribe token in the bodies and the header", async () => {
    const message = await sentThrough("tok-1");
    const link = "https://pulse.example.com/unsubscribe?token=tok-1";

    expect(message.to).toBe("reader@example.com");
    expect(message.html).toContain(`href="${link}"`);
    expect(message.text).toContain(link);
    expect(message.headers).toEqual({ "List-Unsubscribe": `<${link}>` });
  });

  it("does not send the one-click header the unsubscribe endpoint cannot honour", async () => {
    const message = await sentThrough("tok-1");
    expect(Object.keys(message.headers ?? {})).not.toContain("List-Unsubscribe-Post");
  });

  it("reports a transport failure instead of throwing", async () => {
    const channel = createEmailChannel({
      from: "Platform Pulse <pulse@localhost>",
      publicUrl: "https://pulse.example.com",
      send: () => Promise.reject(new Error("connection refused")),
    });
    expect(
      await channel.send(digest([event("lh", {})]), { email: "a@b.co", unsubscribeToken: "t" }),
    ).toEqual({ status: "failed", error: "connection refused" });
  });
});
