import { useEffect, useState } from "react";
import type { DigestView } from "../core/digest.ts";
import { DigestArticle } from "./digest-article.tsx";
import { fetchLatestDigest } from "./digest-source.ts";
import { SignupForm } from "./signup-form.tsx";
import { getReaderClient } from "./supabase.ts";
import { CONFIRM_ACTION, TokenAction, UNSUBSCRIBE_ACTION } from "./token-action.tsx";

type LoadState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error" }
  | { status: "ready"; digest: DigestView };

/** The reader proper. A component of its own so the token pages never fetch a digest. */
const LatestDigest = () => {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    // getReaderClient throws on a bundle built without the Supabase env
    // vars, so it has to run inside the chain: a misconfigured deploy should
    // reach the error branch, not escape the effect.
    Promise.resolve()
      .then(() => fetchLatestDigest(getReaderClient()))
      .then((digest) => {
        if (cancelled) return;
        setState(digest === null ? { status: "empty" } : { status: "ready", digest });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      {state.status === "loading" && (
        <p className="reader__status" aria-live="polite">
          Loading the latest digest…
        </p>
      )}
      {state.status === "empty" && (
        <p className="reader__status">No digest yet — run the pipeline to produce one.</p>
      )}
      {state.status === "error" && (
        <p className="reader__status">The latest digest could not be loaded.</p>
      )}
      {state.status === "ready" && <DigestArticle digest={state.digest} />}
      <SignupForm />
    </>
  );
};

/**
 * There is no router: the host serves this one page for every path
 * (wrangler.jsonc's single-page-application fallback), so the view is chosen
 * from the path the email links point at.
 */
const View = () => {
  const { pathname, search } = window.location;
  const token = new URLSearchParams(search).get("token") || null;

  if (pathname === "/confirm") return <TokenAction action={CONFIRM_ACTION} token={token} />;
  if (pathname === "/unsubscribe") return <TokenAction action={UNSUBSCRIBE_ACTION} token={token} />;
  return <LatestDigest />;
};

export const App = () => (
  <main className="reader">
    <header className="reader__masthead">
      <h1 className="reader__title">Platform Pulse</h1>
      <p className="reader__tagline">What changed across the web platform</p>
    </header>
    <View />
  </main>
);
