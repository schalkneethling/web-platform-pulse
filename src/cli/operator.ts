import type { Sql } from "../store/db.ts";
import { linkOperator, unlinkOperator } from "../store/store.ts";

/**
 * `operator link <auth-user-id>`: tell the database which Supabase Auth user is
 * the operator, so that user's token passes `is_operator_request()`. The id is
 * the one `/curate` shows to a signed-in account that is not yet the operator.
 *
 * It acts on the operator row named by the address, and does not create one:
 * the pipeline owns who the operator is, and linking is only the second half
 * of that. Returns false, after saying why, when no operator has the address.
 */
export const runOperatorLink = async (
  sql: Sql,
  operatorEmail: string,
  authUserId: string,
  write: (line: string) => void = console.log,
): Promise<boolean> => {
  if (!(await linkOperator(sql, operatorEmail, authUserId))) {
    write(NO_OPERATOR);
    return false;
  }
  write(`Linked auth user ${authUserId} to the operator. That account can now curate at /curate.`);
  return true;
};

/** `operator unlink`: nobody can curate from the browser until `operator link` runs again. */
export const runOperatorUnlink = async (
  sql: Sql,
  operatorEmail: string,
  write: (line: string) => void = console.log,
): Promise<boolean> => {
  const outcome = await unlinkOperator(sql, operatorEmail);
  if (outcome === "no-operator") {
    write(NO_OPERATOR);
    return false;
  }
  write(
    outcome === "unlinked"
      ? "Unlinked the operator. Nobody can curate at /curate until `operator link` runs again."
      : "The operator was not linked; nothing changed.",
  );
  return true;
};

const NO_OPERATOR =
  "There is no operator with that address. Run `vp run pulse` once with the same address, " +
  "which creates the operator, then link again.";
