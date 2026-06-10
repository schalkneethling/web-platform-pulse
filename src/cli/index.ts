// The prototype trigger (§12): one idempotent run of the whole pipeline.
//   vp run pulse              pulls live web-features data
//   vp run pulse -- --data tests/fixtures/web-features/new.json
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fetchWebFeaturesData } from "../adapters/web-features.ts";
import type { WebFeaturesData } from "../core/web-features/diff.ts";
import { connect } from "../store/db.ts";
import { runPipeline } from "./pipeline.ts";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    email: { type: "string" },
  },
});

const dataPath = values.data;
const fetchData = dataPath
  ? () => Promise.resolve(JSON.parse(readFileSync(dataPath, "utf8")) as WebFeaturesData)
  : fetchWebFeaturesData;

const subscriberEmail =
  values.email ?? process.env.PULSE_SUBSCRIBER_EMAIL ?? "operator@example.com";

const sql = connect();
try {
  const summary = await runPipeline(sql, { fetchData, subscriberEmail });
  console.log(
    `candidates: ${summary.candidates} | created: ${summary.ingest.created}, ` +
      `correlated: ${summary.ingest.correlated}, unchanged: ${summary.ingest.unchanged} | ` +
      `digest: ${summary.digestId ?? "none (nothing new)"}`,
  );
} finally {
  await sql.end();
}
