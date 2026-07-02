import { withinColdStartWindow } from "../cold-start.ts";
import type { CandidateEvent } from "../types.ts";

export type BrowserName = "chrome" | "firefox" | "safari";

export type ReleaseChannel = "stable" | "beta" | "dev" | "canary" | "nightly" | "preview";

/** One observed release on any channel, however its feed encodes it. */
export interface BrowserRelease {
  browser: BrowserName;
  channel: ReleaseChannel;
  version: string;
  /** ISO date (YYYY-MM-DD) when the feed carries one. */
  releasedAt: string | null;
  url: string;
}

/** The cursor: the last version seen per browser and channel. */
export type ReleaseIndex = Record<string, string>;

const SOURCE_ID = "browser-releases";

const BROWSER_LABELS: Record<BrowserName, string> = {
  chrome: "Chrome",
  firefox: "Firefox",
  safari: "Safari",
};

const CHANNEL_LABELS: Record<ReleaseChannel, string | null> = {
  stable: null,
  beta: "Beta",
  dev: "Dev",
  canary: "Canary",
  nightly: "Nightly",
  preview: "Technology Preview",
};

/** "Chrome" for stable, "Firefox Nightly" and friends for the rest. */
const releaseLabel = (release: BrowserRelease): string => {
  const channel = CHANNEL_LABELS[release.channel];
  const browser = BROWSER_LABELS[release.browser];
  return channel === null ? browser : `${browser} ${channel}`;
};

const cursorKey = (release: BrowserRelease): string => `${release.browser}:${release.channel}`;

export const deriveReleaseIndex = (releases: BrowserRelease[]): ReleaseIndex => {
  const index: ReleaseIndex = {};
  for (const release of releases) {
    index[cursorKey(release)] = release.version;
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
  const label = releaseLabel(release);
  return {
    type: "browser-release",
    subject: { kind: "browser", name: release.browser, version: release.version },
    title: `${label} ${release.version} released`,
    before: before === null ? null : { version: before, channel: release.channel },
    after: { version: release.version, channel: release.channel },
    occurredAt: release.releasedAt,
    taxonomy: ["browser"],
    dedupeKey: `browser-releases:release:${cursorKey(release)}:${release.version}`,
    correlationKey: `browser-release:${cursorKey(release)}:${release.version}`,
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
    const before = prev[cursorKey(release)] ?? null;
    if (before === release.version) continue;
    events.push(releaseCandidate(release, before, options.observedAt));
  }
  return events;
};
