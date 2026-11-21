import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_EMAIL_FROM, readSettings } from "./config.ts";

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
