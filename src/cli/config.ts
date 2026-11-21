import type { CliValues } from "./command.ts";

/** The sender every command uses unless `PULSE_EMAIL_FROM` says otherwise. */
export const DEFAULT_EMAIL_FROM = "Platform Pulse <pulse@localhost>";

/**
 * What the flags and the environment say about mail, read in one place so no
 * command repeats the lookup or its precedence (a flag beats the environment).
 * Nothing is required here: each command decides which settings it needs and
 * what to say when one is missing.
 */
export interface Settings {
  smtpUrl: string | undefined;
  publicUrl: string | undefined;
  /** Names the operator; only the pipeline and `issue preview` use it. */
  operatorEmail: string | undefined;
  from: string;
}

export const readSettings = (
  values: Pick<CliValues, "smtp" | "email">,
  env: Record<string, string | undefined>,
): Settings => ({
  smtpUrl: values.smtp ?? env.PULSE_SMTP_URL,
  publicUrl: env.PULSE_PUBLIC_URL,
  operatorEmail: values.email ?? env.PULSE_SUBSCRIBER_EMAIL,
  from: env.PULSE_EMAIL_FROM ?? DEFAULT_EMAIL_FROM,
});

export interface MailConfig {
  ok: true;
  smtpUrl: string;
  publicUrl: string;
  from: string;
}

export type ConfigResult<T> = T | { ok: false; message: string };

/**
 * The mail settings an `issue` command that sends needs: SMTP and the public
 * URL the unsubscribe link is built on. A missing one returns a message
 * instead of exiting, so the dispatcher owns the exit code (2, a configuration
 * error) and this stays testable.
 */
export const requireMail = (command: string, settings: Settings): ConfigResult<MailConfig> => {
  if (!settings.smtpUrl) {
    return { ok: false, message: `${command} needs SMTP: set PULSE_SMTP_URL or pass --smtp.` };
  }
  if (!settings.publicUrl) {
    return {
      ok: false,
      message: `${command} needs PULSE_PUBLIC_URL: it is the base of the unsubscribe link in the email.`,
    };
  }
  return {
    ok: true,
    smtpUrl: settings.smtpUrl,
    publicUrl: settings.publicUrl,
    from: settings.from,
  };
};

/**
 * The operator address, for a command that acts on the operator's own row.
 * There is no default: guessing one would act on a stranger's row.
 */
export const requireOperatorEmail = (
  command: string,
  settings: Settings,
): ConfigResult<{ ok: true; email: string }> => {
  if (!settings.operatorEmail) {
    return {
      ok: false,
      message: `${command} needs the operator address: set PULSE_SUBSCRIBER_EMAIL or pass --email.`,
    };
  }
  return { ok: true, email: settings.operatorEmail };
};
