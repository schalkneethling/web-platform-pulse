// Local development/test REST layer: PostgREST over the same disposable
// Postgres, standing in for Supabase's. The reader now talks to PostgREST
// rather than a dev-server middleware, so the browser tests need one to
// talk to -- and running the real thing means the e2e suite exercises the
// slice F.2 policies rather than trusting them.
//
// Supabase's anon key is a JWT carrying `role: anon`, signed with the
// project's JWT secret; PostgREST reads the role from it and runs the
// request as that Postgres role. The same arrangement locally, with a
// throwaway secret, keeps the client code identical to production.
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { DEFAULT_DATABASE_URL } from "../src/store/db.ts";
import { ensureContainer } from "./docker.ts";

const CONTAINER = "wpp-postgrest";

/** Local only, and never used to sign anything that leaves this machine. */
const JWT_SECRET = "pulse-local-development-jwt-secret-not-a-credential";

export const REST_PORT = 54332;
export const REST_URL = `http://localhost:${REST_PORT}`;

const base64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

/** Mint the local equivalent of a Supabase anon key (HS256, `role: anon`). */
export const anonKey = (): string => {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = base64url(
    JSON.stringify({ role: "anon", iss: "pulse-local", iat: issuedAt, exp: issuedAt + 3600 }),
  );
  const signature = base64url(
    createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${signature}`;
};

const waitForReady = async (): Promise<void> => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(`${REST_URL}/`, {
        headers: { Authorization: `Bearer ${anonKey()}` },
      });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error("PostgREST did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

/** Idempotently bring up PostgREST against the local database. */
export const ensurePostgrest = async (): Promise<void> => {
  // The container reaches the host's Postgres, not a container-network one.
  const dbUri = (process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL).replace(
    "localhost",
    "host.docker.internal",
  );
  ensureContainer(
    CONTAINER,
    // host-gateway is a no-op on Docker Desktop, which resolves
    // host.docker.internal already, and is what makes the same line work on
    // Linux, where it does not resolve by default.
    `--add-host=host.docker.internal:host-gateway ` +
      `-e PGRST_DB_URI=${dbUri} -e PGRST_DB_SCHEMA=public -e PGRST_DB_ANON_ROLE=anon ` +
      `-e PGRST_JWT_SECRET=${JWT_SECRET} -p ${REST_PORT}:3000 postgrest/postgrest`,
  );

  // A reset database is a new schema to a PostgREST that was already
  // running, and it caches the old one until told otherwise.
  const sql = postgres(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, { onnotice: () => {} });
  try {
    await sql.unsafe("notify pgrst, 'reload schema'");
  } finally {
    await sql.end();
  }

  await waitForReady();
};
