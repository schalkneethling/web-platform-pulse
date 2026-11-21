import { parseArgs } from "node:util";

/** Every flag the CLI accepts. Each command reads the ones it needs. */
export const parseCli = (argv: string[]) =>
  parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      data: { type: "string" },
      releases: { type: "string" },
      runtimes: { type: "string" },
      positions: { type: "string" },
      chrome: { type: "string" },
      specs: { type: "string" },
      "tag-reviews": { type: "string" },
      voices: { type: "string" },
      email: { type: "string" },
      smtp: { type: "string" },
    },
  });

export type CliValues = ReturnType<typeof parseCli>["values"];

export type Command =
  | { kind: "pipeline" }
  | { kind: "confirmations" }
  | { kind: "issue-open" }
  | { kind: "issue-preview" }
  | { kind: "issue-publish" }
  | { kind: "issue-retry" }
  | { kind: "unknown"; message: string };

const VALID_COMMANDS =
  '"confirmations", "issue open", "issue preview", "issue publish" and "issue retry"';

/**
 * Maps the positional arguments to a command without touching the environment,
 * the database or any adapter, so the dispatcher can decide before any setup
 * runs. An unknown command names the valid ones.
 */
export const resolveCommand = (positionals: string[]): Command => {
  const [subcommand, ...extra] = positionals;
  if (subcommand === undefined) return { kind: "pipeline" };
  if (subcommand === "confirmations" && extra.length === 0) return { kind: "confirmations" };
  if (subcommand === "issue" && extra.length === 1 && extra[0] === "open") {
    return { kind: "issue-open" };
  }
  if (subcommand === "issue" && extra.length === 1 && extra[0] === "preview") {
    return { kind: "issue-preview" };
  }
  if (subcommand === "issue" && extra.length === 1 && extra[0] === "publish") {
    return { kind: "issue-publish" };
  }
  if (subcommand === "issue" && extra.length === 1 && extra[0] === "retry") {
    return { kind: "issue-retry" };
  }
  return {
    kind: "unknown",
    message: `unknown command: ${positionals.join(" ")} (the valid subcommands are ${VALID_COMMANDS})`,
  };
};
