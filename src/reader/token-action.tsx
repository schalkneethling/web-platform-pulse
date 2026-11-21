import { useRef, useState } from "react";
import { getReaderClient } from "./supabase.ts";

/**
 * What differs between the confirm and unsubscribe pages. Everything else is
 * the same interaction (a token from the link, one button, one RPC call), so
 * one component serves both and they change together.
 */
export interface TokenActionConfig {
  heading: string;
  explanation: string;
  buttonLabel: string;
  successText: string;
  /** The migration 6 function this page calls through PostgREST. */
  rpc: "confirm_subscription" | "unsubscribe";
}

export const CONFIRM_ACTION: TokenActionConfig = {
  heading: "Confirm your subscription",
  explanation: "Press the button to start receiving the Platform Pulse digest by email.",
  buttonLabel: "Confirm subscription",
  successText: "You are subscribed. The next digest will arrive in your inbox.",
  rpc: "confirm_subscription",
};

export const UNSUBSCRIBE_ACTION: TokenActionConfig = {
  heading: "Unsubscribe",
  explanation: "Press the button to stop receiving the Platform Pulse digest by email.",
  buttonLabel: "Unsubscribe",
  successText: "You are unsubscribed. You will not receive any more digests.",
  rpc: "unsubscribe",
};

type ActionState = "idle" | "working" | "done" | "invalid";

const INVALID_TEXT = "This link is not valid.";
const INCOMPLETE_TEXT =
  "This link is incomplete: it has no token. Open the link from your email again.";

interface TokenActionProps {
  action: TokenActionConfig;
  /** The `token` query parameter, or null when the link had none. */
  token: string | null;
}

/**
 * The page behind a link in an email. The action runs only when the person
 * presses the button, never on page load: mail scanners and link previewers
 * open links, and a page that acted on load would confirm or unsubscribe
 * somebody who never saw the message.
 *
 * The RPC answers true for a valid token and false for an unknown or
 * superseded one. Tokens never expire, so the message claims no more than
 * that the link is not valid. An error (a malformed token is a 400, a network failure) is
 * shown as the same "not valid" state: the person can do nothing different,
 * and a raw error would only leak implementation detail.
 */
export const TokenAction = ({ action, token }: TokenActionProps) => {
  const [state, setState] = useState<ActionState>("idle");
  const statusRef = useRef<HTMLParagraphElement>(null);

  const handleClick = async () => {
    if (token === null) return;
    setState("working");
    try {
      const { data, error } = await getReaderClient().rpc(action.rpc, {
        presented_token: token,
      });
      setState(error || data !== true ? "invalid" : "done");
    } catch {
      setState("invalid");
    }
    // The button is disabled while working and removed once done, either of
    // which drops keyboard focus to the page body. Land it on the outcome.
    statusRef.current?.focus();
  };

  const status =
    token === null
      ? INCOMPLETE_TEXT
      : state === "done"
        ? action.successText
        : state === "invalid"
          ? INVALID_TEXT
          : "";

  return (
    <section className="reader__token-action" aria-labelledby="token-action-title">
      <h2 className="reader__token-action-title" id="token-action-title">
        {action.heading}
      </h2>
      {token !== null && state !== "done" && (
        <>
          <p>{action.explanation}</p>
          <button
            className="button"
            type="button"
            disabled={state === "working"}
            onClick={handleClick}
          >
            {action.buttonLabel}
          </button>
        </>
      )}
      <p className="reader__token-action-status" aria-live="polite" ref={statusRef} tabIndex={-1}>
        {status}
      </p>
      <p>
        <a href="/">Back to the latest digest</a>
      </p>
    </section>
  );
};
