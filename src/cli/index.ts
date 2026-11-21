// The prototype trigger (§12): one idempotent run of the whole pipeline.
//   vp run pulse              pulls live web-features data and release feeds
//   vp run pulse -- --data tests/fixtures/web-features/new.json
//   vp run pulse -- --releases tests/fixtures/browser-releases/new.json
//   vp run pulse -- --runtimes tests/fixtures/runtime-releases/new.json
//   vp run pulse -- --positions tests/fixtures/standards-positions/new.json
//   vp run pulse -- --chrome tests/fixtures/chrome-status/new.json
//   vp run pulse -- --specs tests/fixtures/w3c-specs/new.json
//   vp run pulse -- --tag-reviews tests/fixtures/tag-reviews/new.json
//   vp run pulse -- --voices tests/fixtures/voices/new.json
//   vp run pulse -- --smtp smtp://localhost:54330   (or PULSE_SMTP_URL)
//   vp run pulse -- --email you@example.com   (or PULSE_SUBSCRIBER_EMAIL)
//       names the operator, and one of the two is required. The operator's
//       digest is what the public reader shows, so passing a different address
//       moves the operator flag and re-points the reader at that subscriber.
//   vp run pulse confirmations   only send pending signup confirmations, then exit
//   vp run pulse issue open      cut the weekly issue's draft (or show the open one);
//       needs only the database, so no SMTP or operator address is read
//   vp run pulse issue preview   mail the open draft, marked as a preview, to the operator
//       (PULSE_SUBSCRIBER_EMAIL or --email); needs PULSE_SMTP_URL (or --smtp) and
//       PULSE_PUBLIC_URL, exits 1 when no draft is open, and writes nothing
//   vp run pulse issue publish   publish the open draft, then email every published issue
//       to each confirmed subscriber who has not received it, oldest issue first, with no
//       taxonomy or significance filter. A draft is required, and it is refused unless it
//       has a title and at least one included item or an intro, so an untouched draft
//       can never go out. Needs PULSE_SMTP_URL (or --smtp) and PULSE_PUBLIC_URL, not
//       the operator address. Exits 1 with no draft, on a refused draft or on any failed
//       send, 2 on a configuration error
//   vp run pulse issue retry     send every owed email for every published issue, oldest
//       first, and publish nothing: the command for a failed send, safe while next
//       week's draft is open. Same settings and exit codes as publish; sends nothing twice
//   vp run pulse operator link <auth-user-id>   record which Supabase Auth user is the
//       operator, so that account can curate at /curate. The id is shown there to a
//       signed-in account that is not yet linked. Needs only the database and the
//       operator address (PULSE_SUBSCRIBER_EMAIL or --email); exits 1 when no
//       operator has that address, 2 on a missing address or an id that is not a uuid
//   vp run pulse operator unlink   remove that link; nobody can curate until it is set again
//
// With no subcommand the run is the pipeline, followed by any pending signup
// confirmations. Sending mail needs PULSE_SMTP_URL and PULSE_PUBLIC_URL (the
// reader's origin, which the confirmation and unsubscribe links are built on).
import { connect } from "../store/db.ts";
import { parseCli, resolveCommand } from "./command.ts";
import { createSmtpSender } from "../delivery/smtp.ts";
import {
  resolvePreviewConfig,
  resolvePublishConfig,
  resolveRetryConfig,
  runIssueOpen,
  runIssuePreview,
  runIssuePublish,
  runIssueRetry,
} from "./issue.ts";
import { readSettings, requireOperatorEmail } from "./config.ts";
import { runOperatorLink, runOperatorUnlink } from "./operator.ts";
import { runPipelineCommand } from "./run.ts";

// A dispatcher and nothing else: the command is resolved before any adapter,
// operator address or mail transport is set up, so each command reads only
// the configuration it needs.
const { values, positionals } = parseCli(process.argv.slice(2));
const command = resolveCommand(positionals);

if (command.kind === "unknown") {
  console.error(command.message);
  process.exit(2);
} else if (command.kind === "issue-open") {
  const sql = connect();
  try {
    await runIssueOpen(sql);
  } finally {
    await sql.end();
  }
} else if (command.kind === "issue-preview") {
  const config = resolvePreviewConfig(values, process.env);
  if (!config.ok) {
    console.error(config.message);
    process.exit(2);
  }
  const sql = connect();
  try {
    const sent = await runIssuePreview(sql, {
      send: createSmtpSender(config.smtpUrl),
      from: config.from,
      to: config.to,
      publicUrl: config.publicUrl,
    });
    if (!sent) process.exitCode = 1;
  } finally {
    await sql.end();
  }
} else if (command.kind === "issue-publish") {
  const config = resolvePublishConfig(values, process.env);
  if (!config.ok) {
    console.error(config.message);
    process.exit(2);
  }
  const sql = connect();
  try {
    const ok = await runIssuePublish(sql, {
      send: createSmtpSender(config.smtpUrl),
      from: config.from,
      publicUrl: config.publicUrl,
    });
    if (!ok) process.exitCode = 1;
  } finally {
    await sql.end();
  }
} else if (command.kind === "issue-retry") {
  const config = resolveRetryConfig(values, process.env);
  if (!config.ok) {
    console.error(config.message);
    process.exit(2);
  }
  const sql = connect();
  try {
    const ok = await runIssueRetry(sql, {
      send: createSmtpSender(config.smtpUrl),
      from: config.from,
      publicUrl: config.publicUrl,
    });
    if (!ok) process.exitCode = 1;
  } finally {
    await sql.end();
  }
} else if (command.kind === "operator-link" || command.kind === "operator-unlink") {
  const name = command.kind === "operator-link" ? "operator link" : "operator unlink";
  const operator = requireOperatorEmail(name, readSettings(values, process.env));
  if (!operator.ok) {
    console.error(operator.message);
    process.exit(2);
  }
  const sql = connect();
  try {
    const ok =
      command.kind === "operator-link"
        ? await runOperatorLink(sql, operator.email, command.authUserId)
        : await runOperatorUnlink(sql, operator.email);
    if (!ok) process.exitCode = 1;
  } finally {
    await sql.end();
  }
} else {
  await runPipelineCommand(values, command.kind === "confirmations");
}
