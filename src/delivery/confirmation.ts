import { escapeHtml, type EmailContent } from "./email.ts";

export interface ConfirmationEmailInput {
  /** The full link keyed on the subscriber's confirm_token. */
  confirmUrl: string;
}

/**
 * The double opt-in message (§17). Anyone can type any address into the
 * signup form, so the mail must read sensibly to someone who never asked for
 * it: it says what it is and that ignoring it changes nothing.
 */
export const renderConfirmationEmail = ({ confirmUrl }: ConfirmationEmailInput): EmailContent => {
  const url = escapeHtml(confirmUrl);

  const html = [
    "<h1>Confirm your Platform Pulse subscription</h1>",
    "  <p>Someone asked for the Platform Pulse digest to be sent to this address.</p>",
    `  <p><a href="${url}">Confirm my subscription</a></p>`,
    "  <p>If you did not ask for this, ignore this message and nothing will be sent to you.</p>",
  ].join("\n");

  const text = [
    "Confirm your Platform Pulse subscription",
    "",
    "Someone asked for the Platform Pulse digest to be sent to this address.",
    "To confirm, open this link:",
    "",
    confirmUrl,
    "",
    "If you did not ask for this, ignore this message and nothing will be sent to you.",
  ].join("\n");

  return { subject: "Confirm your Platform Pulse subscription", text, html };
};
