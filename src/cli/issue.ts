import { isUnannotated } from "../core/issue.ts";
import type { SendEmail } from "../delivery/email.ts";
import { renderIssueEmail } from "../delivery/issue-email.ts";
import { unsubscribeUrl } from "../delivery/links.ts";
import { scrubCredentials } from "../delivery/scrub.ts";
import type { Sql } from "../store/db.ts";
import {
  getDraftIssue,
  getLatestPublishedIssue,
  openIssue,
  publishDraft,
  recordIssueDelivery,
  subscribersAwaitingIssue,
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

/**
 * `issue publish`: publish the open draft, then send the most recently
 * published issue to every subscriber who is still owed it.
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
 *
 * Re-running is therefore safe: with nothing new to publish it retries only
 * failed sends. Returns false when the draft was refused or any send failed,
 * which the dispatcher turns into exit code 1.
 */
export const runIssuePublish = async (
  sql: Sql,
  deps: PublishDeps,
  write: (line: string) => void = console.log,
): Promise<boolean> => {
  const publication = await publishDraft(sql);
  if (publication.outcome === "refused") {
    write(
      `issue #${publication.number} was not published: it has no included item and no intro. ` +
        "Add an intro or an item first.",
    );
    return false;
  }
  if (publication.outcome === "published") write(`issue #${publication.number} published`);

  const issue = await getLatestPublishedIssue(sql);
  if (!issue) {
    write("There is no issue to publish and nothing to retry. Run `issue open` first.");
    return true;
  }
  if (isUnannotated(issue.items)) {
    write("warning: no included item has a note, so this issue reads as a changelog");
  }

  const pending = await subscribersAwaitingIssue(sql, issue.id, ISSUE_CHANNEL);
  if (pending.length === 0 && publication.outcome === "no-draft") {
    write(`issue #${issue.number} is already published and nothing is waiting to be sent`);
    return true;
  }

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
      // The address is deliberately not logged: CI logs are shared.
      const message = scrubCredentials(error instanceof Error ? error.message : String(error));
      await recordIssueDelivery(sql, issue.id, recipient.subscriberId, ISSUE_CHANNEL, {
        status: "failed",
        error: message,
      });
      console.error(
        `issue #${issue.number} to subscriber ${recipient.subscriberId} failed: ${message}`,
      );
      failed += 1;
      continue;
    }
    await recordIssueDelivery(sql, issue.id, recipient.subscriberId, ISSUE_CHANNEL, {
      status: "sent",
    });
    sent += 1;
  }
  write(`issue #${issue.number}: ${sent} sent, ${failed} failed`);
  return failed === 0;
};
