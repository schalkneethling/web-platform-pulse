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
    // There are no retries, so "on-first-retry" would never record anything.
    // A failure keeps its trace instead, which CI uploads with the results.
    trace: "retain-on-failure",
  },
  // The weekly issue allows one draft at a time and the specs below publish
  // it, so the specs that touch the draft must not overlap each other. They
  // run as a chain of single-file projects (a project starts only when the
  // projects it depends on have finished). The public-page specs never touch
  // the draft and run alongside them.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: ["**/issue-*.spec.ts", "**/curate.spec.ts"],
    },
    {
      name: "issue-rest",
      use: { ...devices["Desktop Chrome"] },
      testMatch: "**/issue-curation-rest.spec.ts",
    },
    {
      // After issue-rest: that spec opens a draft from the seeded events and
      // deletes it, and this one publishes an issue, which moves the window
      // the next draft would start from.
      name: "curate",
      use: { ...devices["Desktop Chrome"] },
      testMatch: "**/curate.spec.ts",
      dependencies: ["issue-rest"],
    },
  ],
  webServer: {
    command: `vp dev --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    // Vite reports a dependency re-optimisation and a page reload on stdout.
    // Hiding it left a CI failure with nothing to read, so it is kept.
    stdout: "pipe",
    stderr: "pipe",
    // Same origin as the page: the dev server proxies /rest/v1 to the local
    // PostgREST (see vite.config.ts), so the client code path is the one
    // production runs -- only the host differs.
    env: {
      // Keeps the dev server's Varlock plugin on .env.test rather than
      // 1Password. The two VITE_ values below still win: process env
      // outranks every .env file.
      APP_ENV: "test",
      VITE_SUPABASE_URL: `http://localhost:${PORT}`,
      VITE_SUPABASE_ANON_KEY: anonKey(),
    },
  },
});
