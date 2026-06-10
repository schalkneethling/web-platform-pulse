import postgres from "postgres";

export type Sql = postgres.Sql;

/** The query surface shared by a connection and an open transaction. */
export type Queryable = postgres.ISql;

export const DEFAULT_DATABASE_URL = "postgres://pulse:pulse@localhost:54329/pulse";

export const connect = (url?: string): Sql =>
  postgres(url ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, {
    onnotice: () => {},
  });
