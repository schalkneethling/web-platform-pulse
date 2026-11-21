import type { BrowserContext } from "@playwright/test";
import { authenticatedToken } from "../scripts/dev-rest.ts";

/** Where supabase-js keeps the curator's session. It is the `storageKey` the
 * curator client sets in src/reader/supabase.ts, and the value is the JSON of
 * a `Session` (auth-js `lib/types.ts`). */
const STORAGE_KEY = "pulse-curator-auth";

export interface SeededSession {
  accessToken: string;
}

/**
 * Signs a browser context in the way supabase-js remembers a sign-in: by
 * writing the session it would have stored after the Google redirect. The
 * access token is minted with the local secret, so PostgREST verifies it like
 * a real one, and its `sub` is `userId`, which is what the operator check reads. Nothing in the reader knows about this; it is the same
 * localStorage entry the SDK reads on every page load.
 *
 * The session never expires during a test (an hour) and its refresh token is
 * never used, so the SDK makes no auth-server request for it: `getSession`
 * returns a stored, unexpired session without a network call.
 *
 * The init script runs before the page's own scripts on every navigation, and
 * only writes when the entry is absent, so a reload keeps whatever the SDK
 * has done to the session since.
 */
export const signInAs = async (
  context: BrowserContext,
  userId: string,
  email?: string,
): Promise<SeededSession> => {
  const accessToken = authenticatedToken(userId, email);
  const now = Math.floor(Date.now() / 1000);
  const session = {
    access_token: accessToken,
    refresh_token: "not-used-by-these-tests",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      // Present in a real session, so a page that displayed it would be caught.
      ...(email === undefined ? {} : { email }),
      app_metadata: { provider: "google", providers: ["google"] },
      user_metadata: {},
      created_at: new Date(now * 1000).toISOString(),
    },
  };
  await context.addInitScript(
    ({ key, value }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    { key: STORAGE_KEY, value: JSON.stringify(session) },
  );
  return { accessToken };
};
