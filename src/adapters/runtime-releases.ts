import type { SourceAdapter } from "../core/adapter.ts";
import {
  deriveRuntimeIndex,
  diffRuntimeReleases,
  type RuntimeIndex,
  type RuntimeRelease,
} from "../core/runtime-releases/diff.ts";
import { fetchJson } from "./http.ts";

export const RUNTIME_RELEASES_SOURCE_ID = "runtime-releases";

/** The published artifacts this differ observes (§5.3), one per runtime. */
export const NODE_INDEX_URL = "https://nodejs.org/dist/index.json";
export const DENO_LATEST_RELEASE_URL = "https://api.github.com/repos/denoland/deno/releases/latest";
export const BUN_LATEST_RELEASE_URL = "https://api.github.com/repos/oven-sh/bun/releases/latest";

interface NodeIndexEntry {
  version: string;
  date: string;
  lts: string | false;
}

const nodeRelease = (entry: NodeIndexEntry, line: "current" | "lts"): RuntimeRelease => ({
  runtime: "node",
  line,
  version: entry.version.replace(/^v/, ""),
  releasedAt: entry.date,
  url: `https://nodejs.org/en/blog/release/${entry.version}`,
});

/**
 * dist/index.json lists every release newest-version-first: the first
 * entry is the newest Current, the first entry carrying an LTS codename
 * is the newest LTS patch.
 */
export const parseNodeIndex = (payload: NodeIndexEntry[]): RuntimeRelease[] => {
  const releases: RuntimeRelease[] = [];
  const current = payload[0];
  if (current) releases.push(nodeRelease(current, "current"));
  const lts = payload.find((entry) => entry.lts !== false);
  if (lts) releases.push(nodeRelease(lts, "lts"));
  return releases;
};

interface GithubRelease {
  tag_name?: unknown;
  published_at?: unknown;
  html_url?: unknown;
  prerelease?: unknown;
}

/** Deno tags "v2.9.1"; Bun tags "bun-v1.3.14". */
export const parseGithubRelease = (
  payload: GithubRelease,
  runtime: "deno" | "bun",
): RuntimeRelease | null => {
  if (typeof payload.tag_name !== "string" || payload.prerelease === true) return null;
  return {
    runtime,
    line: "stable",
    version: payload.tag_name.replace(/^(bun-)?v/, ""),
    releasedAt: typeof payload.published_at === "string" ? payload.published_at.slice(0, 10) : null,
    url:
      typeof payload.html_url === "string"
        ? payload.html_url
        : `https://github.com/${runtime === "deno" ? "denoland/deno" : "oven-sh/bun"}/releases`,
  };
};

/** Actions' GITHUB_TOKEN lifts the unauthenticated api.github.com rate limit. */
const githubHeaders = (): Record<string, string> => {
  const token = process.env.GITHUB_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
};

export const fetchRuntimeReleases = async (): Promise<RuntimeRelease[]> => {
  const [node, deno, bun] = await Promise.all([
    fetchJson<NodeIndexEntry[]>(NODE_INDEX_URL).then(parseNodeIndex),
    fetchJson<GithubRelease>(DENO_LATEST_RELEASE_URL, { headers: githubHeaders() }).then(
      (payload) => parseGithubRelease(payload, "deno"),
    ),
    fetchJson<GithubRelease>(BUN_LATEST_RELEASE_URL, { headers: githubHeaders() }).then((payload) =>
      parseGithubRelease(payload, "bun"),
    ),
  ]);
  return [...node, deno, bun].filter((release) => release !== null);
};

export interface RuntimeReleasesAdapterOptions {
  fetchReleases: () => Promise<RuntimeRelease[]>;
  now?: () => Date;
}

export const createRuntimeReleasesAdapter = (
  options: RuntimeReleasesAdapterOptions,
): SourceAdapter<RuntimeIndex> => {
  const now = options.now ?? (() => new Date());
  return {
    sourceId: RUNTIME_RELEASES_SOURCE_ID,
    kind: "artifact-diff",
    run: async (cursor) => {
      const releases = await options.fetchReleases();
      const current = now();
      const events = diffRuntimeReleases(cursor, releases, {
        now: current,
        observedAt: current.toISOString(),
      });
      // The cursor only advances for lines this run observed, so a feed
      // that yields no release cannot erase another line's memory.
      return { events, cursor: { ...cursor, ...deriveRuntimeIndex(releases) } };
    },
  };
};
