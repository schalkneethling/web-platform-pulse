import { describe, expect, it } from "vite-plus/test";
import { describeSendFailure, scrubCredentials } from "./scrub.ts";

/** The shape nodemailer gives a rejected recipient: the server's reply is appended to the message. */
const rejected = () =>
  Object.assign(
    new Error(
      "Can't send mail - all recipients were rejected: 550 5.1.1 <alice@example.com>: Recipient address rejected",
    ),
    { code: "EENVELOPE", responseCode: 550, response: "550 5.1.1 <alice@example.com>: rejected" },
  );

describe("scrubCredentials", () => {
  it("replaces the userinfo of a URL", () => {
    expect(scrubCredentials("connect ECONNREFUSED smtp://user:hunter2@smtp.example.com:587")).toBe(
      "connect ECONNREFUSED smtp://***@smtp.example.com:587",
    );
  });
});

describe("describeSendFailure", () => {
  it("logs only the error code and the server's response code", () => {
    const { diagnostic } = describeSendFailure(rejected());
    expect(diagnostic).toBe("code EENVELOPE, response code 550");
    expect(diagnostic).not.toContain("alice");
  });

  it("keeps the full message for storage, with credentials scrubbed", () => {
    const { message } = describeSendFailure(
      new Error("connect ECONNREFUSED smtp://user:hunter2@smtp.example.com:587"),
    );
    expect(message).toBe("connect ECONNREFUSED smtp://***@smtp.example.com:587");
  });

  it("says none when the error carries no code, whatever was thrown", () => {
    expect(describeSendFailure(new Error("boom")).diagnostic).toBe("code none, response code none");
    expect(describeSendFailure("a string").diagnostic).toBe("code none, response code none");
    expect(describeSendFailure("a string").message).toBe("a string");
  });

  it("does not trust a code that is not a short identifier", () => {
    const hostile = Object.assign(new Error("x"), {
      code: "bob@example.com rejected",
      responseCode: "550 bob@example.com",
    });
    expect(describeSendFailure(hostile).diagnostic).toBe("code none, response code none");
  });
});
