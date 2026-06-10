// Local mail catcher for development and the delivery tests: Mailpit
// accepts SMTP and exposes the inbox over HTTP. A real provider (or the
// operator's own SMTP server) replaces this outside local development.
import { ensureContainer } from "./docker.ts";

const CONTAINER = "wpp-mailpit";

export const MAILPIT_SMTP_URL = "smtp://localhost:54330";
export const MAILPIT_API_URL = "http://localhost:54331";

const waitForReady = async (): Promise<void> => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(`${MAILPIT_API_URL}/api/v1/info`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("mailpit did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

/** Idempotently bring up the mail catcher. */
export const ensureMailpit = async (): Promise<void> => {
  ensureContainer(CONTAINER, "-p 54330:1025 -p 54331:8025 axllent/mailpit");
  await waitForReady();
};
