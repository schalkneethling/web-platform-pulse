// Seeds the database for the outer e2e test by running the real pipeline
// twice over the committed fixture pair: the first run cold-starts the
// source index from old.json, the second observes new.json and emits the
// transitions the digest must contain.
import { readFileSync } from "node:fs";
import { ensureDatabase } from "../scripts/dev-db.ts";
import { ensureMailpit } from "../scripts/dev-mail.ts";
import { ensurePostgrest } from "../scripts/dev-rest.ts";
import { createWebFeaturesAdapter } from "../src/adapters/web-features.ts";
import type { WebFeaturesData } from "../src/core/web-features/diff.ts";
import { runPipeline } from "../src/cli/pipeline.ts";
import { connect, type Sql } from "../src/store/db.ts";

const load = (name: string): WebFeaturesData =>
  JSON.parse(
    readFileSync(new URL(`../tests/fixtures/web-features/${name}`, import.meta.url), "utf8"),
  ) as WebFeaturesData;

// A second confirmed subscriber who owns a digest cut AFTER the operator's.
// Before migration 7 the reader showed whichever digest ended last, so this
// digest would have replaced the operator's on the page.
const seedOtherSubscriberDigest = async (sql: Sql): Promise<void> => {
  const [other] = await sql<{ id: string }[]>`
    insert into subscriber (email, confirmed_at) values ('other@example.com', now())
    returning id
  `;
  const [latest] = await sql<{ window_end: Date }[]>`
    select max(window_end) as window_end from digest
  `;
  const [digest] = await sql<{ id: string }[]>`
    insert into digest (subscriber_id, cadence, window_start, window_end)
    values (${other!.id}, 'daily', ${latest!.window_end}, ${latest!.window_end}::timestamptz + interval '1 day')
    returning id
  `;
  await sql`
    insert into digest_item (digest_id, event_id, position)
    select ${digest!.id}, id, 0 from change_event where title ilike '%lh%' limit 1
  `;
};

export default async function globalSetup(): Promise<void> {
  await ensureDatabase({ reset: true });
  const sql = connect();
  try {
    for (const fixture of ["old.json", "new.json"]) {
      await runPipeline(sql, {
        adapters: [createWebFeaturesAdapter({ fetchData: () => Promise.resolve(load(fixture)) })],
        subscriberEmail: "operator@example.com",
        // Windows cut only once they elapse; the seed pretends to run a day later.
        now: () => new Date(Date.now() + 25 * 60 * 60 * 1000),
      });
    }
    await seedOtherSubscriberDigest(sql);
  } finally {
    await sql.end();
  }
  // After the seed, so the schema cache PostgREST loads is the migrated one.
  await ensurePostgrest();
  // The curation spec previews and publishes an issue through the real SMTP
  // sender, so the mail catcher has to be up.
  await ensureMailpit();
}
