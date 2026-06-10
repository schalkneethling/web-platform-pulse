import { useEffect, useState } from "react";
import type { DigestView } from "../core/digest.ts";
import { DigestArticle } from "./digest-article.tsx";

type LoadState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error" }
  | { status: "ready"; digest: DigestView };

export const App = () => {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/digest/latest")
      .then((response) => {
        if (!response.ok) throw new Error(`digest fetch failed: ${response.status}`);
        return response.json() as Promise<{ digest: DigestView | null }>;
      })
      .then(({ digest }) => {
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
    <main className="reader">
      <header className="reader__masthead">
        <h1 className="reader__title">Platform Pulse</h1>
        <p className="reader__tagline">What changed across the web platform</p>
      </header>
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
    </main>
  );
};
