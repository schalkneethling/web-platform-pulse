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
    expect(resolveCommand(["issue", "retry"])).toEqual({ kind: "issue-retry" });
  });

  it("resolves operator link with a uuid, lower-casing it, and operator unlink", () => {
    expect(resolveCommand(["operator", "link", "3F2504E0-4F89-41D3-9A0C-0305E82C3301"])).toEqual({
      kind: "operator-link",
      authUserId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    });
    expect(resolveCommand(["operator", "unlink"])).toEqual({ kind: "operator-unlink" });
  });

  it.each([
    [["operator", "link"], /needs the auth user id/],
    [["operator", "link", "not-a-uuid"], /not-a-uuid/],
    [
      ["operator", "link", "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "extra"],
      /needs the auth user id/,
    ],
    [["operator", "link", "{3f2504e0-4f89-41d3-9a0c-0305e82c3301}"], /needs the auth user id/],
  ])("rejects %j as bad input to operator link", (positionals, message) => {
    const command = resolveCommand(positionals);
    expect(command.kind).toBe("unknown");
    if (command.kind === "unknown") expect(command.message).toMatch(message);
  });

  it.each([
    [["issue"]],
    [["operator"]],
    [["operator", "unlink", "extra"]],
    [["issue", "preview", "extra"]],
    [["issue", "publish", "extra"]],
    [["issue", "retry", "extra"]],
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
      expect(command.message).toContain("issue retry");
      expect(command.message).toContain("operator link");
      expect(command.message).toContain("operator unlink");
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
