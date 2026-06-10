import { ensureDatabase } from "../../scripts/dev-db.ts";
import { ensureMailpit } from "../../scripts/dev-mail.ts";

export default async function setup(): Promise<void> {
  await Promise.all([ensureDatabase({ reset: true }), ensureMailpit()]);
}
