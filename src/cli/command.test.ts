import { describe, expect, it } from "vite-plus/test";
import { parseCli, resolveCommand } from "./command.ts";

describe("resolveCommand", () => {
  it("runs the pipeline when no subcommand is given", () => {
    expect(resolveCommand([])).toEqual({ kind: "pipeline" });
  });

  it("resolves confirmations and issue open", () => {
    expect(resolveCommand(["confirmations"])).toEqual({ kind: "confirmations" });
    expect(resolveCommand(["issue", "open"])).toEqual({ kind: "issue-open" });
    expect(resolveCommand(["issue", "preview"])).toEqual({ kind: "issue-preview" });
    expect(resolveCommand(["issue", "publish"])).toEqual({ kind: "issue-publish" });
  });

  it.each([
    [["issue"]],
    [["issue", "preview", "extra"]],
    [["issue", "publish", "extra"]],
    [["issue", "send"]],
    [["issue", "open", "extra"]],
    [["confirmations", "extra"]],
    [["nonsense"]],
  ])("rejects %j as unknown and names the valid subcommands", (positionals) => {
    const command = resolveCommand(positionals);
    expect(command.kind).toBe("unknown");
    if (command.kind === "unknown") {
      expect(command.message).toContain(positionals.join(" "));
      expect(command.message).toContain("issue open");
      expect(command.message).toContain("issue preview");
      expect(command.message).toContain("issue publish");
      expect(command.message).toContain("confirmations");
    }
  });
});

describe("parseCli", () => {
  it("separates flags from positionals", () => {
    const { values, positionals } = parseCli(["issue", "open", "--email", "a@example.com"]);
    expect(positionals).toEqual(["issue", "open"]);
    expect(values.email).toBe("a@example.com");
  });
});
