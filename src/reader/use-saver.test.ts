import { describe, expect, it } from "vite-plus/test";
import { saveStatusText } from "./use-saver.ts";

describe("saveStatusText", () => {
  it("is empty before anything was saved, and says what happened after", () => {
    expect(saveStatusText({ kind: "idle" })).toBe("");
    expect(saveStatusText({ kind: "saving" })).toBe("Saving…");
    expect(saveStatusText({ kind: "saved" })).toBe("Saved.");
  });

  it("tells a failed text save that what was typed is still there", () => {
    expect(saveStatusText({ kind: "failed", message: "boom", reverted: false })).toBe(
      "Not saved: boom What you typed is still here.",
    );
  });

  it("tells a failed include or exclude that the checkbox went back, not that text was kept", () => {
    const text = saveStatusText({ kind: "failed", message: "boom", reverted: true });
    expect(text).toBe("Not saved: boom The checkbox is back to what is saved.");
    expect(text).not.toMatch(/typed/);
  });
});
