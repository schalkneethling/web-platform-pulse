import type { CandidateEvent } from "../types.ts";

export type Vendor = "mozilla" | "webkit";

/**
 * One vendor's stance on one proposal, however the vendor's artifact
 * encodes it. `position` keeps the vendor's native vocabulary
 * (Mozilla: positive/negative/neutral/defer; WebKit:
 * support/oppose/neutral/blocked); null means requested but not taken.
 */
export interface VendorPosition {
  vendor: Vendor;
  /** The vendor's issue number — stable per proposal. */
  key: string;
  position: string | null;
  title: string;
  specUrl: string | null;
  issueUrl: string;
  topics: string[];
}

/** The cursor: the last position seen per vendor and proposal. */
export type PositionIndex = Record<string, string>;

const SOURCE_ID = "standards-positions";

/** In the cursor, "no position yet" must survive a round-trip. */
const NO_POSITION = "none";

const VENDOR_LABELS: Record<Vendor, string> = {
  mozilla: "Mozilla",
  webkit: "WebKit",
};

/**
 * Vendor-native positions phrased for a digest one-liner. Anything a
 * vendor invents later falls back to a neutral "position on X: value".
 */
const POSITION_PHRASES: Record<string, (title: string) => string> = {
  positive: (title) => `Mozilla is positive on ${title}`,
  negative: (title) => `Mozilla is negative on ${title}`,
  defer: (title) => `Mozilla defers on ${title}`,
  support: (title) => `WebKit supports ${title}`,
  oppose: (title) => `WebKit opposes ${title}`,
  blocked: (title) => `WebKit's review of ${title} is blocked`,
};

const positionTitle = (position: VendorPosition, taken: string): string => {
  if (taken === "neutral")
    return `${VENDOR_LABELS[position.vendor]} is neutral on ${position.title}`;
  const phrase = POSITION_PHRASES[taken];
  return phrase
    ? phrase(position.title)
    : `${VENDOR_LABELS[position.vendor]} position on ${position.title}: ${taken}`;
};

/** Both vendors tag proposals; only a few tags map onto digest themes. */
const themeFromTopics = (topics: string[]): string => {
  const lowered = topics.map((topic) => topic.toLowerCase());
  for (const theme of ["css", "html", "javascript"]) {
    if (lowered.includes(theme)) return theme;
  }
  return "api";
};

/** A subject shortname readable in logs: the spec URL minus its scheme. */
const specShortname = (position: VendorPosition): string =>
  (position.specUrl ?? position.issueUrl).replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

const cursorKey = (position: VendorPosition): string => `${position.vendor}:${position.key}`;

export const derivePositionIndex = (positions: VendorPosition[]): PositionIndex => {
  const index: PositionIndex = {};
  for (const position of positions) {
    index[cursorKey(position)] = position.position ?? NO_POSITION;
  }
  return index;
};

const positionCandidate = (
  position: VendorPosition,
  taken: string,
  before: string | null,
  observedAt: string,
): CandidateEvent => {
  const title = positionTitle(position, taken);
  return {
    type: "vendor-position",
    subject: { kind: "spec", shortname: specShortname(position) },
    title,
    before: before === null ? null : { position: before },
    after: { position: taken, specUrl: position.specUrl },
    // The artifacts carry no dates; the observation time is all we have.
    occurredAt: null,
    taxonomy: [themeFromTopics(position.topics)],
    dedupeKey: `standards-positions:position:${cursorKey(position)}:${taken}`,
    // A vendor taking a position is one real-world event per stance:
    // Mozilla and WebKit judging the same spec stay separate items.
    correlationKey: `vendor-position:${cursorKey(position)}:${taken}`,
    provenance: [{ sourceId: SOURCE_ID, url: position.issueUrl, title, observedAt }],
  };
};

/**
 * Cold start (§5.3): the artifacts are undated, so there is no window to
 * replay — the first run seeds every known position silently and events
 * flow as vendors take or revise positions from then on.
 */
export const diffVendorPositions = (
  prev: PositionIndex | null,
  positions: VendorPosition[],
  options: { observedAt: string },
): CandidateEvent[] => {
  if (prev === null) return [];

  const events: CandidateEvent[] = [];
  for (const position of positions) {
    const taken = position.position;
    // A request awaiting triage (or a withdrawn position) is not digest
    // material; the cursor still records it via derivePositionIndex.
    if (taken === null) continue;
    const before = prev[cursorKey(position)] ?? null;
    if (before === taken) continue;
    events.push(
      positionCandidate(
        position,
        taken,
        before === NO_POSITION ? null : before,
        options.observedAt,
      ),
    );
  }
  return events;
};
