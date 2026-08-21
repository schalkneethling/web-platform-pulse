import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { REST_URL } from "./scripts/dev-rest.ts";

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
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
