/**
 * A calendar date in UTC, so the same instant reads as the same day for
 * everyone. A digest's window is cut on UTC boundaries, and a date shown in
 * the reader's own time zone could name a different day from the one in the
 * email. The long British form ("14 June 2026") is the one the digest email uses.
 */
export const formatUtcDate = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-GB", { dateStyle: "long", timeZone: "UTC" });
