import { isUnannotated } from "../core/issue.ts";
import type { Sql } from "../store/db.ts";
import { getDraftIssue, openIssue } from "../store/issue.ts";

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
