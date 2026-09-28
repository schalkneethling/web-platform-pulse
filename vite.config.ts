import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { REST_URL } from "./scripts/dev-rest.ts";

// Varlock replaces Vite's .env loading with .env.schema, so the dev server
// and the build resolve VITE_SUPABASE_* from 1Password -- or from .env.test
// under APP_ENV=test. Only those commands need it: `vp check` and `vp test`
// load this file too, and resolving 1Password in order to lint, or to run
// tests that take their setup from scripts/ and fixtures, would be a prompt
// nobody asked for. VP_RAW_SUBCOMMAND is how Vite+ tells the config which
// command is loading it. It is not documented; if it goes away, the symptom
// is a dev server whose reader throws for want of VITE_SUPABASE_URL.
//
// Imported here rather than at the top: merely importing the integration
// resolves the schema, so a static import would put the prompt back.
const needsConfig = ["dev", "build", "preview"].includes(process.env.VP_RAW_SUBCOMMAND ?? "");
const plugins = [react(), babel({ presets: [reactCompilerPreset()] })];
if (needsConfig) {
  const { varlockVitePlugin } = await import("@varlock/vite-integration");
  plugins.unshift(varlockVitePlugin());
}

export default defineConfig({
  plugins,
  server: {
    // supabase-js always addresses `<project url>/rest/v1`. Locally the
    // project is a bare PostgREST container with no such prefix, so the dev
    // server strips it. Nothing here runs in a production build: there
    // VITE_SUPABASE_URL is the real project and the browser goes direct.
    proxy: {
      "/rest/v1": {
        target: REST_URL,
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/rest\/v1/, ""),
      },
    },
  },
  staged: {
    "*": "vp check --fix",
  },
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          globalSetup: ["./tests/integration/global-setup.ts"],
          fileParallelism: false,
        },
      },
    ],
  },
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
