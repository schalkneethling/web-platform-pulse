import { withinColdStartWindow } from "../cold-start.ts";
import type { CandidateEvent } from "../types.ts";

export type BrowserName = "chrome" | "firefox" | "safari";

/** One observed stable release, however its feed encodes it. */
export interface BrowserRelease {
  browser: BrowserName;
  version: string;
  /** ISO date (YYYY-MM-DD) when the feed carries one. */
  releasedAt: string | null;
  url: string;
}

/** The cursor: the last stable version seen per browser. */
export type ReleaseIndex = Partial<Record<BrowserName, string>>;

const SOURCE_ID = "browser-releases";

const BROWSER_LABELS: Record<BrowserName, string> = {
  chrome: "Chrome",
  firefox: "Firefox",
  safari: "Safari",
};

export const deriveReleaseIndex = (releases: BrowserRelease[]): ReleaseIndex => {
  const index: ReleaseIndex = {};
  for (const release of releases) {
    index[release.browser] = release.version;
  }
  return index;
};

interface DiffOptions {
  now: Date;
  observedAt: string;
}

const releaseCandidate = (
  release: BrowserRelease,
  before: string | null,
  observedAt: string,
): CandidateEvent => {
  const label = BROWSER_LABELS[release.browser];
  return {
    type: "browser-release",
    subject: { kind: "browser", name: release.browser, version: release.version },
    title: `${label} ${release.version} released`,
    before: before === null ? null : { version: before },
    after: { version: release.version },
    occurredAt: release.releasedAt,
    taxonomy: ["browser"],
    dedupeKey: `browser-releases:release:${release.browser}:${release.version}`,
    correlationKey: `browser-release:${release.browser}:${release.version}`,
    provenance: [
      { sourceId: SOURCE_ID, url: release.url, title: `${label} ${release.version}`, observedAt },
    ],
  };
};

/**
 * Cold start (§5.3): with no prior index the versions are seeded
 * silently, emitting only releases dated within the window before now.
 */
const coldStartEvents = (releases: BrowserRelease[], options: DiffOptions): CandidateEvent[] =>
  releases
    .filter((release) => withinColdStartWindow(release.releasedAt, options.now))
    .map((release) => releaseCandidate(release, null, options.observedAt));

export const diffBrowserReleases = (
  prev: ReleaseIndex | null,
  releases: BrowserRelease[],
  options: DiffOptions,
): CandidateEvent[] => {
  if (prev === null) return coldStartEvents(releases, options);

  const events: CandidateEvent[] = [];
  for (const release of releases) {
    const before = prev[release.browser] ?? null;
    if (before === release.version) continue;
    events.push(releaseCandidate(release, before, options.observedAt));
  }
  return events;
};
