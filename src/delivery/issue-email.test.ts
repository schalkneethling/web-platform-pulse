import { describe, expect, it } from "vite-plus/test";
import type { IssueItemView } from "../store/issue.ts";
import type { ChangeEvent } from "../core/types.ts";
import { renderIssueEmail } from "./issue-email.ts";

const LINK = "https://pulse.example.com/unsubscribe?token=abc";

const event = (title: string, url = "https://example.com/a", sourceId = "web-features") =>
  ({
    id: title,
    type: "baseline-change",
    title,
    provenance: [{ sourceId, url, title: "p", observedAt: "2026-01-01T00:00:00Z" }],
  }) as unknown as ChangeEvent;

const item = (
  title: string,
  section: IssueItemView["section"],
  overrides: Partial<IssueItemView> = {},
): IssueItemView => ({
  position: 1,
  section,
  note: null,
  included: true,
  event: event(title),
  ...overrides,
});

const issue = { number: 4, title: "Anchor positioning lands", intro: "A busy week." };
const render = (
  items: IssueItemView[],
  options: { preview?: boolean; issue?: typeof issue } = {},
) =>
  renderIssueEmail(options.issue ?? issue, items, {
    unsubscribeLink: LINK,
    preview: options.preview ?? false,
  });

describe("renderIssueEmail", () => {
  it("orders sections by SECTION_ORDER with their labels and omits empty ones", () => {
    const { html, text } = render([
      item("Voice item", "voices"),
      item("Shipped item", "shipped"),
      item("Lead item", "lead"),
    ]);
    const order = (body: string, ...needles: string[]) => needles.map((n) => body.indexOf(n));
    const htmlAt = order(html, "Lead item", "Shipped item", "Voice item");
    expect(htmlAt).toEqual([...htmlAt].sort((a, b) => a - b));
    expect(htmlAt.every((i) => i >= 0)).toBe(true);
    expect(html).toContain("<h2>Lead</h2>");
    expect(html).toContain("<h2>Shipped</h2>");
    expect(html).toContain("<h2>Voices</h2>");
    expect(html).not.toContain("Worth watching");
    expect(text).not.toContain("Worth watching");
    expect(text).toContain("# Voices");
  });

  it("puts the note before the title and does not shrink it below the title", () => {
    const { html, text } = render([
      item("Grid thing", "shipped", { note: "This changes layouts." }),
    ]);
    expect(html.indexOf("This changes layouts.")).toBeLessThan(html.indexOf("Grid thing"));
    expect(html).toContain('<p class="issue-note"');
    expect(html).not.toMatch(/class="issue-note"[^>]*font-size:\s*0?\.[0-9]+(em|rem)/);
    expect(html).not.toMatch(/class="issue-note"[^>]*color:\s*#?(666|777|888|999)/);
    expect(text.indexOf("This changes layouts.")).toBeLessThan(text.indexOf("Grid thing"));
  });

  it("links the title to the first provenance URL and names the source", () => {
    const { html, text } = render([
      item("Grid thing", "shipped", {
        event: {
          ...event("Grid thing", "https://example.com/first"),
          provenance: [
            {
              sourceId: "web-features",
              url: "https://example.com/first",
              title: "a",
              observedAt: "",
            },
            {
              sourceId: "chrome-status",
              url: "https://example.com/second",
              title: "b",
              observedAt: "",
            },
          ],
        },
      }),
    ]);
    expect(html).toContain('<a href="https://example.com/first">Grid thing</a>');
    expect(html).not.toContain("https://example.com/second");
    // The source is the host a reader sees in the digest, not the adapter's machine id.
    expect(html).toContain("— example.com</span>");
    expect(html).not.toContain("web-features");
    expect(text).toContain("https://example.com/first");
    expect(text).toContain("Source: example.com");
    expect(text).not.toContain("web-features");
  });

  it("styles the lead section larger through a class and inline style", () => {
    const { html } = render([item("Lead item", "lead"), item("Other", "shipped")]);
    expect(html).toContain('class="issue-section issue-section-lead"');
    expect(html).toMatch(/class="issue-event"[^>]*font-size:\s*1\.[0-9]+em/);
    expect(html).toContain('class="issue-section issue-section-shipped"');
  });

  it("escapes the title, intro and notes", () => {
    const { html, subject } = render(
      [item("<b>bold</b>", "shipped", { note: '<script>alert("x")</script>' })],
      { issue: { number: 1, title: "<img src=x onerror=1>", intro: "<script>1</script>" } },
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(subject).toContain("<img src=x onerror=1>");
  });

  it.each(["javascript:alert(1)", "data:text/html,hi", "ftp://example.com/x", "not a url"])(
    "does not turn %s into a link",
    (url) => {
      const { html, text } = render([
        item("Odd source", "shipped", { event: event("Odd source", url) }),
      ]);
      expect(html).not.toContain(`href="${url}"`);
      expect(html).not.toMatch(/href="(javascript|data|ftp):/);
      expect(html).toContain("Odd source");
      expect(text).not.toContain(url);
    },
  );

  it("renders blank-line separated paragraphs for the intro and notes", () => {
    const { html, text } = render([item("X", "shipped", { note: "First note.\n\nSecond note." })], {
      issue: { number: 1, title: "", intro: "Intro one.\n\n\nIntro two.\nsame paragraph." },
    });
    expect(html).toContain("<p>Intro one.</p>");
    expect(html).toContain("<p>Intro two.<br />same paragraph.</p>");
    expect(html).toContain("First note.</p>");
    expect(html).toContain("Second note.</p>");
    expect(text).toContain("First note.\n\nSecond note.");
  });

  it("builds the subject with and without a title", () => {
    expect(render([]).subject).toBe("Platform Pulse #4: Anchor positioning lands");
    expect(render([], { issue: { number: 4, title: "  ", intro: "x" } }).subject).toBe(
      "Platform Pulse #4",
    );
  });

  it("shows the banner and subject prefix only in a preview with no annotated item", () => {
    const bare = [item("A", "shipped")];
    const preview = render(bare, { preview: true });
    expect(preview.subject).toBe("[Preview] Platform Pulse #4: Anchor positioning lands");
    expect(preview.html).toContain("issue-preview-banner");
    expect(preview.text).toContain("[Preview]");

    const published = render(bare);
    expect(published.html).not.toContain("issue-preview-banner");
    expect(published.subject.startsWith("[Preview]")).toBe(false);

    const annotated = render([item("A", "shipped", { note: "Why it matters." })], {
      preview: true,
    });
    expect(annotated.html).not.toContain("issue-preview-banner");
    expect(annotated.subject).toBe("[Preview] Platform Pulse #4: Anchor positioning lands");
  });

  it("prefixes the subject in every preview and never in the sent issue", () => {
    const heading = "Platform Pulse #4: Anchor positioning lands";
    const cases: [string, IssueItemView[]][] = [
      ["no items", []],
      ["an un-annotated item", [item("A", "shipped")]],
      ["an annotated item", [item("A", "shipped", { note: "Why it matters." })]],
    ];
    for (const [, items] of cases) {
      expect(render(items, { preview: true }).subject).toBe(`[Preview] ${heading}`);
      expect(render(items).subject).toBe(heading);
    }
  });

  it("marks the plain-text body of every preview and never of the sent issue", () => {
    const cases: [string, IssueItemView[]][] = [
      ["no items", []],
      ["an un-annotated item", [item("A", "shipped")]],
      ["an annotated item", [item("A", "shipped", { note: "Why it matters." })]],
    ];
    for (const [, items] of cases) {
      expect(render(items, { preview: true }).text.startsWith("[Preview]")).toBe(true);
      expect(render(items).text).not.toContain("[Preview]");
    }
  });

  it("carries the unsubscribe link in both bodies", () => {
    const { html, text } = render([item("A", "shipped")]);
    expect(html).toContain(`<a href="${LINK}">Unsubscribe</a>`);
    expect(text).toContain(LINK);
  });

  it("renders an issue with an intro and no items", () => {
    const { html, text } = render([], { preview: true });
    expect(html).toContain("A busy week.");
    expect(html).not.toContain("<h2>");
    expect(html).not.toContain("issue-preview-banner");
    expect(text).toContain("A busy week.");
  });

  it("never renders excluded items, nor counts them for the banner", () => {
    const { html, text } = render(
      [
        item("Kept", "shipped"),
        item("Dropped", "watch", { included: false, note: "A great sentence." }),
      ],
      { preview: true },
    );
    expect(html).not.toContain("Dropped");
    expect(html).not.toContain("A great sentence.");
    expect(text).not.toContain("Dropped");
    expect(html).not.toContain("Worth watching");
    expect(html).toContain("issue-preview-banner");
  });
});
