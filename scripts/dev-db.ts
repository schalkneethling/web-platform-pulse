// Local development/test database: a disposable Postgres in Docker, with
// the supabase/migrations applied. The Supabase stack replaces this once
// the project moves onto it; the migrations are already in its format.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { DEFAULT_DATABASE_URL } from "../src/store/db.ts";
import { ensureContainer } from "./docker.ts";

const CONTAINER = "wpp-postgres";

const MIGRATIONS_DIR = new URL("../supabase/migrations", import.meta.url).pathname;

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
  ensureContainer(
    CONTAINER,
    "-e POSTGRES_USER=pulse -e POSTGRES_PASSWORD=pulse -e POSTGRES_DB=pulse " +
      "-p 54329:5432 postgres:17-alpine",
  );

  const sql = postgres(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, {
    onnotice: () => {},
  });
  try {
    await waitForReady(sql);
    if (options.reset) {
      await sql.unsafe("drop schema public cascade; create schema public;");
    }
    await sql.unsafe(
      "create table if not exists _migration (name text primary key, applied_at timestamptz not null default now())",
    );
    const applied = new Set(
      (await sql<{ name: string }[]>`select name from _migration`).map((row) => row.name),
    );
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      await sql.begin(async (tx) => {
        await tx.unsafe(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
        await tx`insert into _migration (name) values (${file})`;
      });
    }
  } finally {
    await sql.end();
  }
};
