// Seeds the database for the outer e2e test by running the real pipeline
// twice over the committed fixture pair: the first run cold-starts the
// source index from old.json, the second observes new.json and emits the
// transitions the digest must contain.
import { readFileSync } from "node:fs";
import { ensureDatabase } from "../scripts/dev-db.ts";
import type { WebFeaturesData } from "../src/core/web-features/diff.ts";
import { runPipeline } from "../src/cli/pipeline.ts";
import { connect } from "../src/store/db.ts";

const load = (name: string): WebFeaturesData =>
  JSON.parse(
    readFileSync(new URL(`../tests/fixtures/web-features/${name}`, import.meta.url), "utf8"),
  ) as WebFeaturesData;

export default async function globalSetup(): Promise<void> {
  await ensureDatabase({ reset: true });
  const sql = connect();
  try {
    for (const fixture of ["old.json", "new.json"]) {
      await runPipeline(sql, {
        fetchData: () => Promise.resolve(load(fixture)),
        subscriberEmail: "operator@example.com",
      });
    }
  } finally {
    await sql.end();
  }
}
