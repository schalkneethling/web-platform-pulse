import { withinColdStartWindow } from "../cold-start.ts";
import type { CandidateEvent } from "../types.ts";

export type RuntimeName = "node" | "deno" | "bun";

/** Node ships two release lines (Current and LTS); Deno and Bun ship one. */
export type ReleaseLine = "current" | "lts" | "stable";

/** One observed runtime release, however its feed encodes it. */
export interface RuntimeRelease {
  runtime: RuntimeName;
  line: ReleaseLine;
  /** Bare semver, no leading "v". */
  version: string;
  /** ISO date (YYYY-MM-DD) when the feed carries one. */
  releasedAt: string | null;
  url: string;
}

/** The cursor: the last version seen per runtime and release line. */
export type RuntimeIndex = Record<string, string>;

const SOURCE_ID = "runtime-releases";

const RUNTIME_LABELS: Record<RuntimeName, string> = {
  node: "Node.js",
  deno: "Deno",
  bun: "Bun",
};

const releaseLabel = (release: RuntimeRelease): string =>
  `${RUNTIME_LABELS[release.runtime]} ${release.version}${release.line === "lts" ? " (LTS)" : ""}`;

const cursorKey = (release: RuntimeRelease): string => `${release.runtime}:${release.line}`;

export const deriveRuntimeIndex = (releases: RuntimeRelease[]): RuntimeIndex => {
  const index: RuntimeIndex = {};
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
  release: RuntimeRelease,
  before: string | null,
  observedAt: string,
): CandidateEvent => {
  const label = releaseLabel(release);
  return {
    type: "runtime-release",
    subject: { kind: "runtime", name: release.runtime, version: release.version },
    title: `${label} released`,
    before: before === null ? null : { version: before, line: release.line },
    after: { version: release.version, line: release.line },
    occurredAt: release.releasedAt,
    taxonomy: ["runtime"],
    dedupeKey: `runtime-releases:release:${cursorKey(release)}:${release.version}`,
    // One version is one real-world release, whichever line observed it.
    correlationKey: `runtime-release:${release.runtime}:${release.version}`,
    provenance: [{ sourceId: SOURCE_ID, url: release.url, title: label, observedAt }],
  };
};

/**
 * Cold start (§5.3): with no prior index the versions are seeded
 * silently, emitting only releases dated within the window before now.
 */
const coldStartEvents = (releases: RuntimeRelease[], options: DiffOptions): CandidateEvent[] =>
  releases
    .filter((release) => withinColdStartWindow(release.releasedAt, options.now))
    .map((release) => releaseCandidate(release, null, options.observedAt));

export const diffRuntimeReleases = (
  prev: RuntimeIndex | null,
  releases: RuntimeRelease[],
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
