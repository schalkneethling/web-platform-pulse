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
//
// With no subcommand the run is the pipeline, followed by any pending signup
// confirmations. Sending mail needs PULSE_SMTP_URL and PULSE_PUBLIC_URL (the
// reader's origin, which the confirmation and unsubscribe links are built on).
import { connect } from "../store/db.ts";
import { parseCli, resolveCommand } from "./command.ts";
import { createSmtpSender } from "../delivery/smtp.ts";
import { resolvePreviewConfig, runIssueOpen, runIssuePreview } from "./issue.ts";
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
} else {
  await runPipelineCommand(values, command.kind === "confirmations");
}
