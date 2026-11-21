import type { DeliveryChannel } from "../core/delivery.ts";
import { capThemeGroup, groupByTheme, THEME_LABELS, type DigestView } from "../core/digest.ts";
import { formatUtcDate } from "../core/dates.ts";
import { listJoin, type SupportRollup } from "../core/support-rollup.ts";
import type { ChangeEvent } from "../core/types.ts";
import { unsubscribeUrl } from "./links.ts";
import { describeSendFailure } from "./scrub.ts";

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

export interface EmailMessage extends EmailContent {
  from: string;
  to: string;
  /** Extra header fields, in nodemailer's `{ name: value }` shape. */
  headers?: Record<string, string>;
}

/** The transport seam: SMTP locally, a provider's API in production. */
export type SendEmail = (message: EmailMessage) => Promise<void>;

export const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** The footer every Platform Pulse email ends with, in HTML and plain text. */
export const unsubscribeFooterHtml = (unsubscribeLink: string): string =>
  `  <p><a href="${escapeHtml(unsubscribeLink)}">Unsubscribe</a> from Platform Pulse.</p>`;

export const unsubscribeFooterText = (unsubscribeLink: string): string =>
  `Unsubscribe from Platform Pulse: ${unsubscribeLink}`;

const themeLabel = (theme: string): string => THEME_LABELS[theme] ?? theme;

/** Provenance rows carry a human title ("lh unit", "Chrome Canary 152…"). */
const itemHtml = (event: ChangeEvent): string => {
  const links = event.provenance
    .map((p) => `<a href="${escapeHtml(p.url)}">${escapeHtml(p.title)}</a>`)
    .join(", ");
  const meta = [
    ...(event.occurredAt === null ? [] : [`Changed on ${formatUtcDate(event.occurredAt)}`]),
    ...(links ? [links] : []),
  ].join(" — ");
  return `    <li><strong>${escapeHtml(event.title)}</strong>${meta ? `<br />${meta}` : ""}</li>`;
};

const itemText = (event: ChangeEvent): string =>
  [
    `- ${event.title}`,
    ...(event.occurredAt === null ? [] : [`  Changed on ${formatUtcDate(event.occurredAt)}`]),
    ...event.provenance.map((p) => `  ${p.url}`),
  ].join("\n");

/** One sentence per rollup, feature names linking to webstatus.dev. */
const rollupHtml = (rollup: SupportRollup): string => {
  const features = listJoin(
    rollup.features.map((f) => `<a href="${escapeHtml(f.url)}">${escapeHtml(f.name)}</a>`),
  );
  return `  <p>${escapeHtml(rollup.lead)} ${features}.</p>`;
};

const rollupText = (rollup: SupportRollup): string =>
  [
    `- ${rollup.lead} ${listJoin(rollup.features.map((f) => f.name))}.`,
    ...rollup.features.map((f) => `  ${f.url}`),
  ].join("\n");

/**
 * The digest as an email: the same DigestView the reader renders, as
 * semantic HTML grouped by theme, with a plain-text alternative. Both end
 * with a footer linking to `unsubscribeLink`, the recipient's own page.
 */
export const renderDigestEmail = (digest: DigestView, unsubscribeLink: string): EmailContent => {
  const count = digest.items.length;
  const noun = count === 1 ? "change" : "changes";
  const subject = `Platform Pulse — ${count} ${noun}`;
  const window = `${formatUtcDate(digest.windowStart)} to ${formatUtcDate(digest.windowEnd)}`;
  const groups = groupByTheme(digest.items);

  const html = [
    "<h1>Platform Pulse</h1>",
    `  <p>${count} ${noun} across the web platform, covering ${window}.</p>`,
    ...groups.flatMap((group) => {
      const { visible, hidden } = capThemeGroup(group);
      // themeUnits always orders events before rollups, so splitting `visible`
      // back into its two halves reproduces the uncapped <ul>/<p> markup exactly.
      const events = visible.flatMap((unit) => (unit.kind === "event" ? [unit.event] : []));
      const rollups = visible.flatMap((unit) => (unit.kind === "rollup" ? [unit.rollup] : []));
      return [
        `  <h2>${escapeHtml(themeLabel(group.theme))}</h2>`,
        ...(events.length > 0 ? ["  <ul>", ...events.map(itemHtml), "  </ul>"] : []),
        ...rollups.map(rollupHtml),
        ...(hidden.length > 0 ? [`  <p>+${hidden.length} more</p>`] : []),
      ];
    }),
    unsubscribeFooterHtml(unsubscribeLink),
  ].join("\n");

  const text = [
    `Platform Pulse — ${count} ${noun}`,
    `Covering ${window}`,
    ...groups.flatMap((group) => {
      const { visible, hidden } = capThemeGroup(group);
      const events = visible.flatMap((unit) => (unit.kind === "event" ? [unit.event] : []));
      const rollups = visible.flatMap((unit) => (unit.kind === "rollup" ? [unit.rollup] : []));
      return [
        "",
        `# ${themeLabel(group.theme)}`,
        "",
        ...events.map(itemText),
        ...rollups.map(rollupText),
        ...(hidden.length > 0 ? [`+${hidden.length} more`] : []),
      ];
    }),
    "",
    unsubscribeFooterText(unsubscribeLink),
  ].join("\n");

  return { subject, text, html };
};

export interface EmailChannelOptions {
  from: string;
  send: SendEmail;
  /** The reader's public origin; each recipient's unsubscribe link is built on it. */
  publicUrl: string;
}

/**
 * The email channel (§10): renders the digest and hands it to the transport.
 * Every message carries the recipient's unsubscribe link in its footer and in
 * a `List-Unsubscribe` header, which mail clients surface as an "Unsubscribe"
 * button.
 *
 * `List-Unsubscribe-Post` (RFC 8058 one-click) is deliberately absent. It
 * makes the mail client POST to the URL itself, but the unsubscribe endpoint
 * is PostgREST, which refuses a request without an `apikey` header, and a
 * mail client cannot send one. The header therefore points at the reader's
 * /unsubscribe page, where the person presses a button.
 */
export const createEmailChannel = (options: EmailChannelOptions): DeliveryChannel => ({
  id: "email",
  send: async (digest, recipient) => {
    const link = unsubscribeUrl(options.publicUrl, recipient.unsubscribeToken);
    try {
      await options.send({
        ...renderDigestEmail(digest, link),
        from: options.from,
        to: recipient.email,
        headers: { "List-Unsubscribe": `<${link}>` },
      });
      return { status: "sent" };
    } catch (error) {
      const { message, diagnostic } = describeSendFailure(error);
      return { status: "failed", error: message, diagnostic };
    }
  },
});
