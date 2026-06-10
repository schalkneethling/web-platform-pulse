import type { DeliveryChannel } from "../core/delivery.ts";
import type { DigestView } from "../core/digest.ts";
import type { ChangeEvent } from "../core/types.ts";

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

export interface EmailMessage extends EmailContent {
  from: string;
  to: string;
}

/** The transport seam: SMTP locally, a provider's API in production. */
export type SendEmail = (message: EmailMessage) => Promise<void>;

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const linkLabel = (url: string): string => new URL(url).hostname;

const itemHtml = (event: ChangeEvent): string => {
  const links = event.provenance
    .map((p) => `<a href="${escapeHtml(p.url)}">${escapeHtml(linkLabel(p.url))}</a>`)
    .join(", ");
  return `    <li><strong>${escapeHtml(event.title)}</strong>${links ? ` — ${links}` : ""}</li>`;
};

const itemText = (event: ChangeEvent): string =>
  [`- ${event.title}`, ...event.provenance.map((p) => `  ${p.url}`)].join("\n");

/**
 * The digest as an email: the same DigestView the reader renders, as
 * semantic HTML with provenance links and a plain-text alternative.
 */
export const renderDigestEmail = (digest: DigestView): EmailContent => {
  const count = digest.items.length;
  const noun = count === 1 ? "change" : "changes";
  const subject = `Platform Pulse — ${count} ${noun}`;
  const upTo = digest.windowEnd.slice(0, 10);

  const html = [
    "<h1>Platform Pulse</h1>",
    `  <p>${count} ${noun} across the web platform, up to ${upTo}.</p>`,
    "  <ol>",
    ...digest.items.map(itemHtml),
    "  </ol>",
  ].join("\n");

  const text = [`Platform Pulse — ${count} ${noun}, up to ${upTo}`, ""]
    .concat(digest.items.map(itemText))
    .join("\n");

  return { subject, text, html };
};

export interface EmailChannelOptions {
  from: string;
  send: SendEmail;
}

/** The email channel (§10): renders the digest and hands it to the transport. */
export const createEmailChannel = (options: EmailChannelOptions): DeliveryChannel => ({
  id: "email",
  send: async (digest, recipient) => {
    try {
      await options.send({
        ...renderDigestEmail(digest),
        from: options.from,
        to: recipient.email,
      });
      return { status: "sent" };
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  },
});
