// Slice F.3 (§6): the browser's Supabase client.
//
// Both values are public by design -- the anon key is a claim about which
// Postgres role the request runs as, not a secret, and it ships inside the
// bundle. What stops it reading a subscriber's address is migration 4, not
// the key being hard to find.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** Fail loudly at startup rather than at first fetch: a bundle built without
 * these is a misconfigured deploy, and a blank reader is a poor way to say so. */
export const createReaderClient = (): SupabaseClient => {
  if (!url || !anonKey) {
    throw new Error(
      "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. The reader needs both at build time.",
    );
  }
  // The reader has no login, so persisting or refreshing a session would
  // only add storage writes and a token refresh timer to a page that reads
  // four tables as anon.
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
};
