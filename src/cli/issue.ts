import { isUnannotated } from "../core/issue.ts";
import type { SendEmail } from "../delivery/email.ts";
import { renderIssueEmail } from "../delivery/issue-email.ts";
import { unsubscribeUrl } from "../delivery/links.ts";
import type { Sql } from "../store/db.ts";
import { getDraftIssue, openIssue } from "../store/issue.ts";
import type { CliValues } from "./command.ts";

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

export interface PreviewConfig {
  ok: true;
  smtpUrl: string;
  /** The operator's address: the only recipient a preview ever has. */
  to: string;
  publicUrl: string;
  from: string;
}

/**
 * Reads what `issue preview` needs from the flags and the environment. A
 * missing setting returns a message instead of exiting, so the dispatcher owns
 * the exit code (2, a configuration error) and this stays testable.
 */
export const resolvePreviewConfig = (
  values: Pick<CliValues, "smtp" | "email">,
  env: Record<string, string | undefined>,
): PreviewConfig | { ok: false; message: string } => {
  const smtpUrl = values.smtp ?? env.PULSE_SMTP_URL;
  if (!smtpUrl) {
    return { ok: false, message: "issue preview needs SMTP: set PULSE_SMTP_URL or pass --smtp." };
  }
  const publicUrl = env.PULSE_PUBLIC_URL;
  if (!publicUrl) {
    return {
      ok: false,
      message:
        "issue preview needs PULSE_PUBLIC_URL: it is the base of the unsubscribe link in the email.",
    };
  }
  const to = values.email ?? env.PULSE_SUBSCRIBER_EMAIL;
  if (!to) {
    return {
      ok: false,
      message:
        "issue preview needs the operator address: set PULSE_SUBSCRIBER_EMAIL or pass --email.",
    };
  }
  return {
    ok: true,
    smtpUrl,
    to,
    publicUrl,
    from: env.PULSE_EMAIL_FROM ?? "Platform Pulse <pulse@localhost>",
  };
};

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
