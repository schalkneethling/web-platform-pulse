import { defineConfig, devices } from "@playwright/test";
import { anonKey } from "./scripts/dev-rest.ts";

const PORT = 5199;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `vp dev --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
    // Same origin as the page: the dev server proxies /rest/v1 to the local
    // PostgREST (see vite.config.ts), so the client code path is the one
    // production runs -- only the host differs.
    env: {
      VITE_SUPABASE_URL: `http://localhost:${PORT}`,
      VITE_SUPABASE_ANON_KEY: anonKey(),
    },
  },
});
