import { describe, expect, it } from "vite-plus/test";
import { renderConfirmationEmail } from "./confirmation.ts";

const confirmUrl = "https://pulse.example.com/confirm?token=2f1c9d3e-0000-4000-8000-000000000000";

describe("renderConfirmationEmail", () => {
  it("has a plain subject", () => {
    expect(renderConfirmationEmail({ confirmUrl }).subject).toBe(
      "Confirm your Platform Pulse subscription",
    );
  });

  it("links to the confirmation URL in both bodies", () => {
    const { html, text } = renderConfirmationEmail({ confirmUrl });
    expect(html).toContain(`<a href="${confirmUrl}">`);
    expect(text).toContain(confirmUrl);
  });

  it("tells a reader who did not ask for it that it can be ignored", () => {
    const { html, text } = renderConfirmationEmail({ confirmUrl });
    expect(html).toMatch(/did not ask for this, ignore this message/);
    expect(text).toMatch(/did not ask for this, ignore this message/);
  });

  it("escapes the URL in the HTML attribute", () => {
    const { html } = renderConfirmationEmail({ confirmUrl: 'https://x.test/c?a=1&b="2"' });
    expect(html).toContain('href="https://x.test/c?a=1&amp;b=&quot;2&quot;"');
    expect(html).not.toContain('b="2"');
  });
});
