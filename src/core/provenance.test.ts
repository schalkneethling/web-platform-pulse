import { describe, expect, it } from "vite-plus/test";
import { sourceName } from "./provenance.ts";

describe("sourceName", () => {
  it("returns the host, including a port", () => {
    expect(sourceName("https://webstatus.dev/features/lh")).toBe("webstatus.dev");
    expect(sourceName("http://localhost:3000/x")).toBe("localhost:3000");
  });

  it.each(["not a url", "data:text/html,hi", "javascript:alert(1)", ""])(
    "returns null for %j",
    (value) => {
      expect(sourceName(value)).toBeNull();
    },
  );
});
