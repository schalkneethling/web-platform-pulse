import { renderConfirmationEmail } from "../delivery/confirmation.ts";
import type { SendEmail } from "../delivery/email.ts";
import { confirmUrl } from "../delivery/links.ts";
import { scrubCredentials } from "../delivery/scrub.ts";
import type { Sql } from "../store/db.ts";
import {
  confirmationsAwaitingSend,
  confirmationsSentInLastDay,
  deleteStaleUnconfirmed,
  recordConfirmationFailed,
  recordConfirmationSent,
} from "../store/store.ts";

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
  /** Stale unconfirmed signups the cleanup removed at the start of the run. */
  cleaned: number;
}

/**
 * A documented ceiling on how much mail a flood of signups can cause: the
 * public form lets anyone queue an address, so one run sends at most this
 * many and the rest wait for the next run.
 */
const DEFAULT_LIMIT = 20;

/**
 * The per-run cap does not bound the day: this workflow runs every 15
 * minutes, so 20 per run could still mean nearly 2000 messages a day. This
 * is the ceiling on confirmation emails sent in any 24 hours, counted from
 * `confirmation_sent_at`. The trade-off: during a flood, genuine signups wait
 * (up to a day) behind the ceiling, which beats letting the form turn our
 * mail account into a spam source.
 */
const DAILY_LIMIT = 200;

/**
 * Send every owed confirmation email (§17). It first removes signups that
 * never confirmed within a week. A failed send counts as an attempt but
 * leaves the row pending, so the next run retries it until the row has used
 * its three attempts; a successful send is recorded with its timestamp. A
 * run sends at most `limit` messages and never takes the last 24 hours past
 * the daily ceiling.
 */
export const sendPendingConfirmations = async (
  sql: Sql,
  options: ConfirmationOptions,
): Promise<ConfirmationSummary> => {
  const summary: ConfirmationSummary = { sent: 0, failed: 0, cleaned: 0 };
  summary.cleaned = await deleteStaleUnconfirmed(sql);

  const headroom = Math.max(0, DAILY_LIMIT - (await confirmationsSentInLastDay(sql)));
  const pending = await confirmationsAwaitingSend(
    sql,
    Math.min(options.limit ?? DEFAULT_LIMIT, headroom),
  );

  for (const { subscriberId, email, confirmToken } of pending) {
    try {
      await options.send({
        ...renderConfirmationEmail({ confirmUrl: confirmUrl(options.publicUrl, confirmToken) }),
        from: options.from,
        to: email,
      });
    } catch (error) {
      // The address is deliberately not logged: CI logs are shared.
      console.error(
        `confirmation ${subscriberId} failed: ` +
          scrubCredentials(error instanceof Error ? error.message : String(error)),
      );
      await recordConfirmationFailed(sql, subscriberId);
      summary.failed += 1;
      continue;
    }
    await recordConfirmationSent(sql, subscriberId);
    summary.sent += 1;
  }

  return summary;
};
