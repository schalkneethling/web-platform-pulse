import { describe, expect, it } from "vite-plus/test";
import { resolvePreviewConfig } from "./issue.ts";

const complete = {
  smtp: "smtp://localhost:54330",
  email: "operator@example.com",
  publicUrl: "https://pulse.example.com",
};

describe("resolvePreviewConfig", () => {
  it("returns the configuration when everything is present", () => {
    expect(
      resolvePreviewConfig(
        {},
        {
          PULSE_SMTP_URL: complete.smtp,
          PULSE_PUBLIC_URL: complete.publicUrl,
          PULSE_SUBSCRIBER_EMAIL: complete.email,
        },
      ),
    ).toEqual({
      ok: true,
      smtpUrl: complete.smtp,
      to: complete.email,
      publicUrl: complete.publicUrl,
      from: "Platform Pulse <pulse@localhost>",
    });
  });

  it("lets flags override the environment and honours PULSE_EMAIL_FROM", () => {
    const result = resolvePreviewConfig(
      { smtp: "smtp://flag", email: "flag@example.com" },
      {
        PULSE_SMTP_URL: complete.smtp,
        PULSE_SUBSCRIBER_EMAIL: complete.email,
        PULSE_PUBLIC_URL: complete.publicUrl,
        PULSE_EMAIL_FROM: "X <x@y>",
      },
    );
    expect(result).toMatchObject({
      ok: true,
      smtpUrl: "smtp://flag",
      to: "flag@example.com",
      from: "X <x@y>",
    });
  });

  it.each([
    [
      "SMTP",
      { PULSE_PUBLIC_URL: complete.publicUrl, PULSE_SUBSCRIBER_EMAIL: complete.email },
      "PULSE_SMTP_URL",
    ],
    [
      "the public URL",
      { PULSE_SMTP_URL: complete.smtp, PULSE_SUBSCRIBER_EMAIL: complete.email },
      "PULSE_PUBLIC_URL",
    ],
    [
      "the operator address",
      { PULSE_SMTP_URL: complete.smtp, PULSE_PUBLIC_URL: complete.publicUrl },
      "PULSE_SUBSCRIBER_EMAIL",
    ],
  ])("names the setting when %s is missing", (_label, env, name) => {
    const result = resolvePreviewConfig({}, env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(name);
  });
});
