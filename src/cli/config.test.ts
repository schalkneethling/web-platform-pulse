import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_EMAIL_FROM, readSettings, requireOperatorEmail } from "./config.ts";

describe("readSettings", () => {
  it("reads every setting from the environment", () => {
    expect(
      readSettings(
        {},
        {
          PULSE_SMTP_URL: "smtp://env",
          PULSE_PUBLIC_URL: "https://pulse.example.com",
          PULSE_SUBSCRIBER_EMAIL: "env@example.com",
          PULSE_EMAIL_FROM: "X <x@y>",
        },
      ),
    ).toEqual({
      smtpUrl: "smtp://env",
      publicUrl: "https://pulse.example.com",
      operatorEmail: "env@example.com",
      from: "X <x@y>",
    });
  });

  it("lets the smtp and email flags beat the environment", () => {
    const settings = readSettings(
      { smtp: "smtp://flag", email: "flag@example.com" },
      { PULSE_SMTP_URL: "smtp://env", PULSE_SUBSCRIBER_EMAIL: "env@example.com" },
    );
    expect(settings.smtpUrl).toBe("smtp://flag");
    expect(settings.operatorEmail).toBe("flag@example.com");
  });

  it("leaves absent settings undefined and defaults only the sender", () => {
    expect(readSettings({}, {})).toEqual({
      smtpUrl: undefined,
      publicUrl: undefined,
      operatorEmail: undefined,
      from: DEFAULT_EMAIL_FROM,
    });
  });
});

describe("requireOperatorEmail", () => {
  it("returns the address, preferring the flag", () => {
    expect(
      requireOperatorEmail(
        "operator link",
        readSettings({ email: "flag@example.com" }, { PULSE_SUBSCRIBER_EMAIL: "env@example.com" }),
      ),
    ).toEqual({ ok: true, email: "flag@example.com" });
  });

  it("names the command and both ways to supply the address when it is missing", () => {
    const result = requireOperatorEmail("operator link", readSettings({}, {}));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("operator link");
      expect(result.message).toContain("PULSE_SUBSCRIBER_EMAIL");
      expect(result.message).toContain("--email");
    }
  });
});
