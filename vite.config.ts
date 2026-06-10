import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite-plus";
import { connect, type Sql } from "./src/store/db.ts";
import { findOperator, getLatestDigest } from "./src/store/store.ts";

/**
 * The slice 1 read seam: the dev server answers the reader's digest
 * fetch straight from PostgreSQL. The Supabase client (anon key + RLS)
 * replaces this seam when the project moves onto the Supabase stack (§6).
 */
const digestApi = (): Plugin => {
  let sql: Sql | null = null;
  return {
    name: "pulse-digest-api",
    configureServer(server) {
      server.middlewares.use("/api/digest/latest", (_req, res) => {
        void (async () => {
          try {
            sql ??= connect();
            const operator = await findOperator(sql);
            const digest = operator === null ? null : await getLatestDigest(sql, operator);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ digest }));
          } catch {
            res.statusCode = 500;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "digest unavailable" }));
          }
        })();
      });
    },
  };
};

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), digestApi()],
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
