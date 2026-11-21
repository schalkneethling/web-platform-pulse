// Slice F.3 (§6) and Slice G.5: the browser's Supabase clients.
//
// Both values are public by design -- the anon key is a claim about which
// Postgres role the request runs as, not a secret, and it ships inside the
// bundle. What stops it reading a subscriber's address is migration 4, not
// the key being hard to find.
//
// There are two clients, not one, and the reason is what supabase-js does with
// a stored session. A client with persistence on reads the session from
// localStorage before every request and sends its access token instead of the
// anon key. If the public pages shared that client, an operator who had signed
// in at /curate would load `/` as the `authenticated` role: the operator would
// see different digests than the public does (migration 7 scopes the digest
// policies to anon), and a visitor with any other Google account would see
// nothing at all, because `authenticated` has no digest policy. The public
// pages must look the same to everyone, so they get a client that cannot hold
// a session:
//
//   getReaderClient()   public pages. Never persists, refreshes or reads a
//                       session, and ignores OAuth parameters in the URL, so
//                       every request carries the anon key.
//   getCuratorClient()  /curate only. Persists the session, refreshes it, and
//                       completes the Google redirect.
//
// Two clients on one storage key would register two auth clients against it,
// which supabase-js warns about and which can interleave their writes. These
// do not share one: each has its own `storageKey`, so neither can see or
// overwrite the other's session. A page builds only one of them.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

const requireConfig = (): { url: string; anonKey: string } => {
  // Missing config throws rather than returning a client that fails at first
  // fetch: a bundle built without these is a misconfigured deploy, and a blank
  // reader is a poor way to say so.
  if (!url || !anonKey) {
    throw new Error(
      "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. The reader needs both at build time.",
    );
  }
  return { url, anonKey };
};

let publicClient: SupabaseClient | null = null;
let curatorClient: SupabaseClient | null = null;

/** The key under which the curator's session is stored in localStorage. The
 * browser tests (e2e/curate-session.ts) seed a session under this name. */
const CURATOR_STORAGE_KEY = "pulse-curator-auth";

/** The anon client every public page uses. One per page. */
export const getReaderClient = (): SupabaseClient => {
  if (publicClient) return publicClient;
  const config = requireConfig();
  // The public pages have no login, so persisting or refreshing a session
  // would only add storage writes and a token refresh timer to a page that
  // reads four tables as anon. With persistence off the client keeps its
  // session in memory, which is always empty, so its requests carry the anon
  // key. `detectSessionInUrl` is off because the default would let a crafted
  // `#access_token=` link sign the public client in.
  publicClient = createClient(config.url, config.anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: "pulse-public-auth",
    },
  });
  return publicClient;
};

/** The signed-in client /curate uses. One per page. */
export const getCuratorClient = (): SupabaseClient => {
  if (curatorClient) return curatorClient;
  const config = requireConfig();
  // PKCE returns a one-time code in the query string instead of the access
  // token in the URL fragment, so the token itself never appears in the
  // address bar or the browser history. supabase-js exchanges the code on load
  // (`detectSessionInUrl`) and removes it from the URL.
  curatorClient = createClient(config.url, config.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce",
      storageKey: CURATOR_STORAGE_KEY,
    },
  });
  return curatorClient;
};
