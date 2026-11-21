import { isUnannotated } from "../core/issue.ts";
import type { SendEmail } from "../delivery/email.ts";
import { renderIssueEmail } from "../delivery/issue-email.ts";
import { unsubscribeUrl } from "../delivery/links.ts";
import { describeSendFailure } from "../delivery/scrub.ts";
import type { Sql } from "../store/db.ts";
import { MAX_FAILED_DELIVERIES } from "../store/store.ts";
import {
  getDraftIssue,
  getIssue,
  listPublishedIssues,
  openIssue,
  publishDraft,
  type PublishRequirement,
  recordIssueDelivery,
  subscribersAwaitingIssue,
  subscribersOutOfRetries,
  withIssueSendLock,
} from "../store/issue.ts";
import type { CliValues } from "./command.ts";
import { readSettings, requireMail, type ConfigResult, type MailConfig } from "./config.ts";

/**
 * `issue open`: cut the draft for the elapsed week, or report the one already
 * open. It needs only the database, so it runs without SMTP or an operator
 * address. The un-annotated warning is printed here because an operator
 * opening a draft is the first moment they can act on it.
 */
export const runIssueOpen = async (sql: Sql, write: (line: string) => void = console.log) => {
  const { created } = await openIssue(sql);
  const draft = await getDraftIssue(sql);
  // The draft was just read inside the same command; it can only be missing if
  // someone published it between the two statements.
  if (!draft) throw new Error("the draft issue disappeared while it was being read");

  const included = draft.items.filter((item) => item.included).length;
  write(
    created
      ? `issue #${draft.number} opened as a draft`
      : `issue #${draft.number} is already open as a draft; nothing changed`,
  );
  write(`window: ${draft.windowStart} to ${draft.windowEnd}`);
  write(created ? `items: ${draft.items.length} pre-filled` : `items: ${included} included`);
  if (isUnannotated(draft.items)) {
    write("warning: no included item has a note yet, so this issue would read as a changelog");
  }
};

export type PreviewConfig = MailConfig & {
  /** The operator's address: the only recipient a preview ever has. */
  to: string;
};

/** Mail settings plus the operator address, which a preview mails and publish does not. */
export const resolvePreviewConfig = (
  values: Pick<CliValues, "smtp" | "email">,
  env: Record<string, string | undefined>,
): ConfigResult<PreviewConfig> => {
  const settings = readSettings(values, env);
  const mail = requireMail("issue preview", settings);
  if (!mail.ok) return mail;
  if (!settings.operatorEmail) {
    return {
      ok: false,
      message:
        "issue preview needs the operator address: set PULSE_SUBSCRIBER_EMAIL or pass --email.",
    };
  }
  return { ...mail, to: settings.operatorEmail };
};

/** `issue publish` mails every subscriber, so it needs no operator address. */
export const resolvePublishConfig = (
  values: Pick<CliValues, "smtp" | "email">,
  env: Record<string, string | undefined>,
): ConfigResult<MailConfig> => requireMail("issue publish", readSettings(values, env));

/** `issue retry` sends the same mail `publish` does, so it needs the same settings. */
export const resolveRetryConfig = (
  values: Pick<CliValues, "smtp" | "email">,
  env: Record<string, string | undefined>,
): ConfigResult<MailConfig> => requireMail("issue retry", readSettings(values, env));

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export interface PreviewDeps {
  send: SendEmail;
  from: string;
  to: string;
  publicUrl: string;
}

/**
 * `issue preview`: render the open draft through the real issue template and
 * mail it to the operator, so the Sunday read-through happens in the artifact
 * subscribers will receive. It only reads: no issue column changes and no
 * `issue_delivery` row is written, so a preview can never be mistaken for a
 * publication. Returns false, after saying so, when there is no draft.
 */
export const runIssuePreview = async (
  sql: Sql,
  deps: PreviewDeps,
  write: (line: string) => void = console.log,
): Promise<boolean> => {
  const draft = await getDraftIssue(sql);
  if (!draft) {
    write("There is no draft issue to preview. Run `issue open` first.");
    return false;
  }
  // The link must not work for anyone. It is shaped like a real unsubscribe
  // link, so the preview looks like the sent email, but it carries the nil UUID,
  // which no subscriber has (tokens come from gen_random_uuid(), a version 4
  // UUID). Using the operator's own token would let a stray click in the
  // read-through unsubscribe the operator from the very issue being checked.
  const unsubscribeLink = unsubscribeUrl(deps.publicUrl, NIL_UUID);
  await deps.send({
    ...renderIssueEmail(draft, draft.items, { unsubscribeLink, preview: true }),
    from: deps.from,
    to: deps.to,
  });
  write(`issue #${draft.number} preview sent to ${deps.to}`);
  return true;
};

export interface PublishDeps {
  send: SendEmail;
  from: string;
  publicUrl: string;
}

/** The only channel an issue goes out on; the column exists so a second one is additive. */
const ISSUE_CHANNEL = "email";

/** What one fan-out did, across every published issue it visited. */
interface FanOutSummary {
  /** True when every owed send that was attempted succeeded. */
  ok: boolean;
  /** Attempts made, so a run that found nothing owed can say so. */
  attempted: number;
}

/**
 * Sends every owed issue email, oldest published issue first, so a subscriber
 * who missed an older issue receives it before its successors.
 *
 * Each recipient is handled in this order: send the email, then record the
 * outcome, the same order the daily digest uses. The unique index on sent rows
 * is what makes a second send structurally impossible once a `sent` row exists,
 * and a subscriber with a `sent` row is not selected again. If the process dies
 * after the provider accepted a message and before its row is written, nothing
 * records that send, so the next run mails that subscriber again. That
 * at-least-once window is deliberate: recording first would turn the same crash
 * into a subscriber who never receives the issue, which is the worse failure
 * for a newsletter.
 */
const sendOwedIssues = async (
  sql: Sql,
  deps: PublishDeps,
  write: (line: string) => void,
): Promise<FanOutSummary> => {
  let ok = true;
  let attempted = 0;
  let gaveUp = 0;
  for (const { id, number } of await listPublishedIssues(sql)) {
    const pending = await subscribersAwaitingIssue(sql, id, ISSUE_CHANNEL);
    if (pending.length > 0) {
      // Loaded only for an issue somebody is owed: most published issues are
      // long since delivered and need no rendering.
      const issue = (await getIssue(sql, id))!;

      let sent = 0;
      let failed = 0;
      for (const recipient of pending) {
        const link = unsubscribeUrl(deps.publicUrl, recipient.unsubscribeToken);
        try {
          await deps.send({
            ...renderIssueEmail(issue, issue.items, { unsubscribeLink: link, preview: false }),
            from: deps.from,
            to: recipient.email,
            headers: { "List-Unsubscribe": `<${link}>` },
          });
        } catch (error) {
          // The database keeps the scrubbed message. The log gets the codes
          // only: CI logs are shared and nodemailer appends the server's reply,
          // which usually names the recipient, to the message.
          const { message, diagnostic } = describeSendFailure(error);
          await recordIssueDelivery(sql, id, recipient.subscriberId, ISSUE_CHANNEL, {
            status: "failed",
            error: message,
            diagnostic,
          });
          console.error(
            `issue #${number} to subscriber ${recipient.subscriberId} failed: ${diagnostic}`,
          );
          failed += 1;
          continue;
        }
        await recordIssueDelivery(sql, id, recipient.subscriberId, ISSUE_CHANNEL, {
          status: "sent",
        });
        sent += 1;
      }
      write(`issue #${number}: ${sent} sent, ${failed} failed`);
      attempted += sent + failed;
      if (failed > 0) ok = false;
    }

    // Asked after the sends, so a subscriber whose last allowed attempt just
    // failed is reported in the same run instead of one run later.
    const exhausted = await subscribersOutOfRetries(sql, id, ISSUE_CHANNEL);
    if (exhausted.length > 0) {
      const who =
        exhausted.length === 1 ? "1 subscriber has" : `${exhausted.length} subscribers have`;
      write(
        `issue #${number}: ${who} used all ${MAX_FAILED_DELIVERIES} attempts and will not be retried ` +
          `(${exhausted.join(", ")})`,
      );
      gaveUp += exhausted.length;
      ok = false;
    }
  }
  // A run that gave up on someone is not "nothing to do", so it never says so.
  if (attempted === 0 && gaveUp === 0) write("nothing is waiting to be sent");
  return { ok, attempted };
};

/**
 * Holds the issue-send lock for the whole of a run that sends. A run that
 * cannot get it says so and returns false (exit 1) without touching the
 * database or the mail transport, because the run that holds it is already
 * sending to the same subscribers.
 */
const underSendLock = async (
  sql: Sql,
  write: (line: string) => void,
  run: () => Promise<boolean>,
): Promise<boolean> => {
  const outcome = await withIssueSendLock(sql, run);
  if (outcome.acquired) return outcome.value;
  write(
    "Another issue publish or retry is already running, so this run sent nothing. " +
      "Run it again when the other has finished.",
  );
  return false;
};

const requirementText: Record<PublishRequirement, string> = {
  title: "a title",
  content: "at least one included item or an intro",
};

/**
 * `issue publish`: publish the open draft, then send every owed email for
 * every published issue, the new one included.
 *
 * A draft is required. Publishing only ever acts on a draft the operator
 * decided to send: the weekly schedule opens next week's pre-filled draft
 * before anyone has written it, so a `publish` that quietly published whatever
 * draft existed would send an unreviewed issue to everyone. A draft with no
 * title is refused for the same reason (the pre-filled draft has none), and so
 * is one with no included item and no intro. With no draft, use `issue retry`
 * to resend failed emails.
 *
 * Returns false when there was no draft, the draft was refused, any send
 * failed or any subscriber has used up their retries, which the dispatcher turns into exit code 1.
 */
export const runIssuePublish = (
  sql: Sql,
  deps: PublishDeps,
  write: (line: string) => void = console.log,
): Promise<boolean> => underSendLock(sql, write, () => publishAndSend(sql, deps, write));

const publishAndSend = async (
  sql: Sql,
  deps: PublishDeps,
  write: (line: string) => void,
): Promise<boolean> => {
  const publication = await publishDraft(sql);
  if (publication.outcome === "no-draft") {
    write(
      "There is no draft issue to publish. Use `issue retry` to resend failed emails of " +
        "published issues, or `issue open` to cut a draft.",
    );
    return false;
  }
  if (publication.outcome === "refused") {
    write(
      `issue #${publication.number} was not published: it needs ` +
        `${publication.missing.map((need) => requirementText[need]).join(" and ")}. ` +
        "Edit it at /curate first.",
    );
    return false;
  }

  write(`issue #${publication.number} published`);
  const published = (await getIssue(sql, publication.id))!;
  if (isUnannotated(published.items)) {
    write("warning: no included item has a note, so this issue reads as a changelog");
  }
  return (await sendOwedIssues(sql, deps, write)).ok;
};

/**
 * `issue retry`: send every owed email for every published issue, oldest
 * first, and publish nothing. This is the command for a failed send, whether
 * it failed in the last run or an issue ago; it never touches a draft, so it
 * is safe to run while next week's draft is open. Returns false when any send
 * failed or any subscriber has used up their retries.
 */
export const runIssueRetry = (
  sql: Sql,
  deps: PublishDeps,
  write: (line: string) => void = console.log,
): Promise<boolean> =>
  underSendLock(sql, write, async () => {
    if ((await listPublishedIssues(sql)).length === 0) {
      write("There is no published issue, so there is nothing to retry.");
      return true;
    }
    return (await sendOwedIssues(sql, deps, write)).ok;
  });
