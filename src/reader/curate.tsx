import { useEffect, useState } from "react";
import { CurationEditor } from "./curation-editor.tsx";
import { fetchCuration, type CurationState } from "./issue-source.ts";
import { getCuratorClient } from "./supabase.ts";

type LoadState = { status: "loading" } | { status: "error" } | CurationState;

/** Whether the curator client holds a session, or null until it has said. */
const useSignedIn = (): boolean | null => {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    // Registering the listener is also what makes supabase-js report the
    // session it recovered from storage or from the Google redirect: the
    // callback is first called with INITIAL_SESSION once that has finished.
    // Only whether a session exists is kept. The SDK also announces SIGNED_IN
    // when a tab regains focus, and acting on the session object itself would
    // reload the draft under the operator's cursor each time.
    //
    // The callback only sets state: supabase-js awaits it, and calling back
    // into the auth client from here can deadlock.
    const { data } = getCuratorClient().auth.onAuthStateChange((_event, session) => {
      setSignedIn(session !== null);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  return signedIn;
};

const SignIn = () => {
  const [error, setError] = useState<string | null>(null);

  const signIn = async () => {
    const { error: failure } = await getCuratorClient().auth.signInWithOAuth({
      provider: "google",
      // Back to this page, which completes the sign-in when it loads.
      options: { redirectTo: `${window.location.origin}/curate` },
    });
    if (failure) setError(failure.message);
  };

  return (
    <>
      <p>Sign in with the operator's Google account to curate the weekly issue.</p>
      <button className="button" type="button" onClick={signIn}>
        Sign in with Google
      </button>
      <p className={`curation__status${error ? " curation__status--failed" : ""}`} role="status">
        {error ? `Sign-in did not start: ${error}` : ""}
      </p>
    </>
  );
};

const SignOut = () => (
  <button
    className="button button--secondary"
    type="button"
    onClick={() => void getCuratorClient().auth.signOut()}
  >
    Sign out
  </button>
);

/**
 * The operator's curation page (/curate). Which of its states shows is
 * decided by the database's answer (see `fetchCuration`), never by anything
 * the browser knows about the account: a signed-in stranger is shown the same
 * "not the operator" message whatever they edit in local storage, and could
 * read and write nothing even if they forced the form open.
 */
export const Curate = () => {
  const signedIn = useSignedIn();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (signedIn === null) return;
    let cancelled = false;
    // A new load is a new question, so the old answer must not stay on screen.
    setState({ status: "loading" });
    fetchCuration(getCuratorClient())
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  return (
    <section className="reader__curate" aria-labelledby="curate-heading">
      <h2 className="reader__curate-title" id="curate-heading">
        Curate the weekly issue
      </h2>
      {state.status === "loading" && (
        <p className="reader__status" role="status">
          Loading…
        </p>
      )}
      {state.status === "error" && (
        <p className="reader__status">The issue could not be loaded. Reload to try again.</p>
      )}
      {state.status === "signed-out" && <SignIn />}
      {state.status === "not-operator" && (
        <>
          <p>This account is not the operator.</p>
          <p>
            If it should be, run <code>vp run pulse operator link</code> with this account's user
            id, then reload this page:
          </p>
          <p>
            <code className="curation__user-id">{state.userId}</code>
          </p>
          <SignOut />
        </>
      )}
      {state.status === "no-draft" && (
        <>
          <p>
            There is no draft issue. Open one with <code>vp run pulse issue open</code>, then reload
            this page.
          </p>
          <SignOut />
        </>
      )}
      {state.status === "draft" && (
        <>
          <CurationEditor draft={state.draft} />
          <SignOut />
        </>
      )}
    </section>
  );
};
