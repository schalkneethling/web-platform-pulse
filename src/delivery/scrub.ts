/**
 * Transport errors can echo a connection URL whose userinfo carries
 * credentials (the SMTP password is an API key); strip that before the
 * text reaches shared CI logs.
 */
export const scrubCredentials = (message: string): string =>
  message.replace(/\/\/[^/@\s]+@/g, "//***@");

export interface SendFailure {
  /** The error's message with credentials scrubbed: for the database, never for a log. */
  message: string;
  /**
   * What is safe to print: the error's code and the server's response code.
   * nodemailer appends the server's whole reply to the message, and a rejected
   * recipient is usually named in it, so the message can carry an address.
   */
  diagnostic: string;
}

/** A code is an identifier such as `EENVELOPE`. Anything else is not trusted into a log. */
const IDENTIFIER = /^[A-Za-z0-9_.-]{1,40}$/;

/**
 * Splits a failed send into what may be stored and what may be logged. Every
 * place that sends mail and logs a failure uses this, so none of them can log
 * an address by interpolating the message.
 */
export const describeSendFailure = (error: unknown): SendFailure => {
  const raw = error instanceof Error ? error.message : String(error);
  const { code, responseCode } = (error ?? {}) as { code?: unknown; responseCode?: unknown };
  const safeCode = typeof code === "string" && IDENTIFIER.test(code) ? code : "none";
  const safeResponse =
    typeof responseCode === "number" && Number.isInteger(responseCode)
      ? String(responseCode)
      : "none";
  return {
    message: scrubCredentials(raw),
    diagnostic: `code ${safeCode}, response code ${safeResponse}`,
  };
};
