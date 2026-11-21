import { useState, type FormEvent } from "react";
import { getReaderClient } from "./supabase.ts";

type SignupState = "idle" | "submitting" | "sent" | "failed";

const MESSAGES: Record<SignupState, string> = {
  idle: "",
  submitting: "Sending…",
  sent: "Check your inbox to confirm your subscription.",
  failed: "We could not sign you up. Check the address and try again.",
};

/**
 * Public signup (§17). The reader holds only the anon key, which cannot touch
 * `subscriber`, so this calls the `request_subscription` function (migration
 * 5). Its answer is the same for a new, pending and already-confirmed
 * address, so the success message promises nothing about which it was.
 */
export const SignupForm = () => {
  const [state, setState] = useState<SignupState>("idle");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const email = new FormData(form).get("email");
    if (typeof email !== "string") return;

    setState("submitting");
    try {
      const { error } = await getReaderClient().rpc("request_subscription", {
        requested_email: email,
      });
      if (error) {
        setState("failed");
        return;
      }
      form.reset();
      setState("sent");
    } catch {
      setState("failed");
    }
  };

  return (
    <section className="reader__signup" aria-labelledby="signup-title">
      <h2 className="reader__signup-title" id="signup-title">
        Get the digest by email
      </h2>
      <form className="signup" onSubmit={handleSubmit}>
        <label className="signup__label" htmlFor="signup-email">
          Email address
        </label>
        <div className="signup__row">
          <input
            className="signup__input"
            id="signup-email"
            name="email"
            type="email"
            required
            autoComplete="email"
          />
          <button className="button" type="submit" disabled={state === "submitting"}>
            Subscribe
          </button>
        </div>
        <p className="signup__status" aria-live="polite">
          {MESSAGES[state]}
        </p>
      </form>
    </section>
  );
};
