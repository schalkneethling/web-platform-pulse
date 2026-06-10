// Local development/test database: a disposable Postgres in Docker, with
// the supabase/migrations applied. The Supabase stack replaces this once
// the project moves onto it; the migrations are already in its format.
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { DEFAULT_DATABASE_URL } from "../src/store/db.ts";

const CONTAINER = "wpp-postgres";

const MIGRATIONS_DIR = new URL("../supabase/migrations", import.meta.url).pathname;

const containerRunning = (): boolean => {
  try {
    return (
      execSync(`docker inspect -f '{{.State.Running}}' ${CONTAINER}`, {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim() === "true"
    );
  } catch {
    return false;
  }
};

const startContainer = (): void => {
  try {
    execSync(`docker start ${CONTAINER}`, { stdio: "ignore" });
  } catch {
    execSync(
      `docker run -d --name ${CONTAINER} ` +
        "-e POSTGRES_USER=pulse -e POSTGRES_PASSWORD=pulse -e POSTGRES_DB=pulse " +
        "-p 54329:5432 postgres:17-alpine",
      { stdio: "ignore" },
    );
  }
};

const waitForReady = async (sql: postgres.Sql): Promise<void> => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await sql`select 1`;
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
};

export interface EnsureOptions {
  reset?: boolean;
}

/** Idempotently bring up the database and apply migrations. */
export const ensureDatabase = async (options: EnsureOptions = {}): Promise<void> => {
  if (!containerRunning()) startContainer();

  const sql = postgres(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, {
    onnotice: () => {},
  });
  try {
    await waitForReady(sql);
    if (options.reset) {
      await sql.unsafe("drop schema public cascade; create schema public;");
    }
    const applied = await sql<{ exists: boolean }[]>`
      select exists (
        select from information_schema.tables
        where table_schema = 'public' and table_name = 'change_event'
      )
    `;
    if (!applied[0]?.exists) {
      const files = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const file of files) {
        await sql.unsafe(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      }
    }
  } finally {
    await sql.end();
  }
};
