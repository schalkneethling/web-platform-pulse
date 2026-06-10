// Shared helpers for the disposable Docker containers behind local
// development: Postgres (dev-db) and Mailpit (dev-mail).
import { execSync } from "node:child_process";

const containerRunning = (name: string): boolean => {
  try {
    return (
      execSync(`docker inspect -f '{{.State.Running}}' ${name}`, {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim() === "true"
    );
  } catch {
    return false;
  }
};

/** Idempotently start a named container, creating it on first use. */
export const ensureContainer = (name: string, runArgs: string): void => {
  if (containerRunning(name)) return;
  try {
    execSync(`docker start ${name}`, { stdio: "ignore" });
  } catch {
    execSync(`docker run -d --name ${name} ${runArgs}`, { stdio: "ignore" });
  }
};
