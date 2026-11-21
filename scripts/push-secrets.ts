// Copies the production configuration from 1Password to GitHub's secret
// store, which is what the workflows read. Run it through Varlock so the
// values resolve from the vault and never touch a file:
//
//   vp run secrets:push              push every secret below
//   vp run secrets:push --dry-run    list what would be pushed, push nothing
//
// 1Password stays the one place a value is edited. Rotating a secret is an
// edit there followed by this command; nothing remote holds a 1Password
// credential, so there is no service account to manage.
import { spawnSync } from "node:child_process";

/** Every repository secret a workflow reads. Keep in step with .env.schema. */
const SECRETS = [
  // pulse.yml
  "DATABASE_URL",
  "PULSE_SMTP_URL",
  "PULSE_SUBSCRIBER_EMAIL",
  "PULSE_EMAIL_FROM",
  // deploy.yml
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
] as const;

const dryRun = process.argv.includes("--dry-run");

// .env.test holds placeholders and the local Docker addresses. Pushing those
// would replace working production secrets with values that only fail at
// 07:00 the next morning.
if (process.env.APP_ENV === "test" && !dryRun) {
  console.error("Not pushing: APP_ENV=test resolves placeholders, not the 1Password item.");
  process.exit(1);
}

// Refuse to push a partial set: a workflow that finds four of its secrets
// fresh and the fifth stale fails in a way that points nowhere near here.
const missing = SECRETS.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(
    `Not pushing: no value for ${missing.join(", ")}. ` +
      "Run this through Varlock (vp run secrets:push) with the 1Password item filled in.",
  );
  process.exit(1);
}

for (const name of SECRETS) {
  if (dryRun) {
    console.log(`would push ${name}`);
    continue;
  }
  // The value goes in on stdin, not as an argument: arguments are visible to
  // every process on the machine for as long as the command runs.
  const result = spawnSync("gh", ["secret", "set", name], {
    input: process.env[name],
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) {
    console.error(`Pushing ${name} failed; stopping.`);
    process.exit(result.status ?? 1);
  }
}
