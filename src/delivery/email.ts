import type { DeliveryChannel } from "../core/delivery.ts";
import { groupByTheme, THEME_LABELS, type DigestView } from "../core/digest.ts";
import { listJoin, splitBrowserSupport, type SupportRollup } from "../core/support-rollup.ts";
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

/** Rendered in UTC so the same digest reads the same everywhere. */
const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-GB", { dateStyle: "long", timeZone: "UTC" });

const themeLabel = (theme: string): string => THEME_LABELS[theme] ?? theme;

/** Provenance rows carry a human title ("lh unit", "Chrome Canary 152…"). */
const itemHtml = (event: ChangeEvent): string => {
  const links = event.provenance
    .map((p) => `<a href="${escapeHtml(p.url)}">${escapeHtml(p.title)}</a>`)
    .join(", ");
  const meta = [
    ...(event.occurredAt === null ? [] : [`Changed on ${formatDate(event.occurredAt)}`]),
    ...(links ? [links] : []),
  ].join(" — ");
  return `    <li><strong>${escapeHtml(event.title)}</strong>${meta ? `<br />${meta}` : ""}</li>`;
};

const itemText = (event: ChangeEvent): string =>
  [
    `- ${event.title}`,
    ...(event.occurredAt === null ? [] : [`  Changed on ${formatDate(event.occurredAt)}`]),
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
 * semantic HTML grouped by theme, with a plain-text alternative.
 */
export const renderDigestEmail = (digest: DigestView): EmailContent => {
  const count = digest.items.length;
  const noun = count === 1 ? "change" : "changes";
  const subject = `Platform Pulse — ${count} ${noun}`;
  const window = `${formatDate(digest.windowStart)} to ${formatDate(digest.windowEnd)}`;
  const groups = groupByTheme(digest.items);

  const html = [
    "<h1>Platform Pulse</h1>",
    `  <p>${count} ${noun} across the web platform, covering ${window}.</p>`,
    ...groups.flatMap((group) => {
      const { rest, rollups } = splitBrowserSupport(group.items);
      return [
        `  <h2>${escapeHtml(themeLabel(group.theme))}</h2>`,
        ...(rest.length > 0 ? ["  <ul>", ...rest.map(itemHtml), "  </ul>"] : []),
        ...rollups.map(rollupHtml),
      ];
    }),
  ].join("\n");

  const text = [
    `Platform Pulse — ${count} ${noun}`,
    `Covering ${window}`,
    ...groups.flatMap((group) => {
      const { rest, rollups } = splitBrowserSupport(group.items);
      return [
        "",
        `# ${themeLabel(group.theme)}`,
        "",
        ...rest.map(itemText),
        ...rollups.map(rollupText),
      ];
    }),
  ].join("\n");

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
