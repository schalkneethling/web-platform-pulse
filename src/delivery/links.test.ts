import { describe, expect, it } from "vite-plus/test";
import { confirmUrl, unsubscribeUrl } from "./links.ts";

const TOKEN = "3f1c0e0e-6d52-4d0a-9d59-0f6a8c1f2b11";

describe("confirmUrl", () => {
  it("puts the token on the /confirm page of the public origin", () => {
    expect(confirmUrl("https://pulse.example.com", TOKEN)).toBe(
      `https://pulse.example.com/confirm?token=${TOKEN}`,
    );
  });

  it("ignores a trailing slash or a path on the public URL", () => {
    expect(confirmUrl("https://pulse.example.com/", TOKEN)).toBe(
      `https://pulse.example.com/confirm?token=${TOKEN}`,
    );
    expect(confirmUrl("https://pulse.example.com/some/where", TOKEN)).toBe(
      `https://pulse.example.com/confirm?token=${TOKEN}`,
    );
  });
});

describe("unsubscribeUrl", () => {
  it("puts the token on the /unsubscribe page of the public origin", () => {
    expect(unsubscribeUrl("https://pulse.example.com", TOKEN)).toBe(
      `https://pulse.example.com/unsubscribe?token=${TOKEN}`,
    );
  });

  it("encodes a value that is not URL-safe", () => {
    expect(unsubscribeUrl("https://pulse.example.com", "a b&c=d")).toBe(
      "https://pulse.example.com/unsubscribe?token=a+b%26c%3Dd",
    );
  });
});
