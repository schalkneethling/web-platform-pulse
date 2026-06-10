import { createTransport } from "nodemailer";
import type { EmailMessage, SendEmail } from "./email.ts";

/**
 * Plain SMTP at the edge (§10): the prototype's transport, pointed at
 * Mailpit locally; a self-hoster points it at their own server, and a
 * provider-API transport can replace it behind the same SendEmail seam.
 */
export const createSmtpSender = (url: string): SendEmail => {
  const transport = createTransport(url);
  return async (message: EmailMessage) => {
    await transport.sendMail(message);
  };
};
