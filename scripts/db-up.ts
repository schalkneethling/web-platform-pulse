import { ensureDatabase } from "./dev-db.ts";

await ensureDatabase();
console.log("database up with migrations applied");
