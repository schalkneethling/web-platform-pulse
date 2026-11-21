/**
 * The name a reader sees for where an item came from: the host of its
 * provenance URL ("webstatus.dev"), never the adapter's machine id
 * ("web-features"). The reader's digest and the issue email both call this so
 * they cannot drift. Returns null when the URL has no host (a malformed
 * value, or a scheme such as `data:`), so a caller can leave the source out
 * instead of printing nothing useful.
 */
export const sourceName = (url: string): string | null => {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
};
