import { ensureDatabase } from "../../scripts/dev-db.ts";

export default async function setup(): Promise<void> {
  await ensureDatabase({ reset: true });
}
