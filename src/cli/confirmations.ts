import { renderConfirmationEmail } from "../delivery/confirmation.ts";
import type { SendEmail } from "../delivery/email.ts";
import { scrubCredentials } from "../delivery/scrub.ts";
import type { Sql } from "../store/db.ts";
import { confirmationsAwaitingSend, recordConfirmationSent } from "../store/store.ts";

export interface ConfirmationOptions {
  send: SendEmail;
  from: string;
  /** The reader's public origin; the confirmation link is built on it. */
  publicUrl: string;
  /** Cap on messages per run. */
  limit?: number;
}

export interface ConfirmationSummary {
  sent: number;
  failed: number;
}

/**
 * A documented ceiling on how much mail a flood of signups can cause: the
 * public form lets anyone queue an address, so one run sends at most this
 * many and the rest wait for the next run.
 */
const DEFAULT_LIMIT = 20;

/**
 * Send every owed confirmation email (§17). A failed send leaves the row
 * pending, so the next run retries it; only a successful send is recorded.
 */
export const sendPendingConfirmations = async (
  sql: Sql,
  options: ConfirmationOptions,
): Promise<ConfirmationSummary> => {
  const summary: ConfirmationSummary = { sent: 0, failed: 0 };
  const pending = await confirmationsAwaitingSend(sql, options.limit ?? DEFAULT_LIMIT);

  for (const { subscriberId, email, confirmToken } of pending) {
    const confirmUrl = new URL("/confirm", options.publicUrl);
    confirmUrl.searchParams.set("token", confirmToken);
    try {
      await options.send({
        ...renderConfirmationEmail({ confirmUrl: confirmUrl.toString() }),
        from: options.from,
        to: email,
      });
    } catch (error) {
      // The address is deliberately not logged: CI logs are shared.
      console.error(
        `confirmation ${subscriberId} failed: ` +
          scrubCredentials(error instanceof Error ? error.message : String(error)),
      );
      summary.failed += 1;
      continue;
    }
    await recordConfirmationSent(sql, subscriberId);
    summary.sent += 1;
  }

  return summary;
};
