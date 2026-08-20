// `vp dev` alone no longer serves the reader: since slice F.3 the page reads
// through PostgREST, so it needs a REST layer running and the two Supabase
// env vars baked into the bundle. This brings up the first and supplies the
// second, then hands off to the dev server.
import { spawnSync } from "node:child_process";
import { anonKey, ensurePostgrest } from "./dev-rest.ts";

/** Must match the origin the dev server listens on: the page and the
 * proxied /rest/v1 path are same-origin by design. */
const PORT = 5173;

await ensurePostgrest();

const result = spawnSync("vp", ["dev", "--port", String(PORT), ...process.argv.slice(2)], {
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_SUPABASE_URL: `http://localhost:${PORT}`,
    VITE_SUPABASE_ANON_KEY: anonKey(),
  },
});

process.exit(result.status ?? 1);
