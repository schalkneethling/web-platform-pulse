import { XMLParser } from "fast-xml-parser";
import type { SourceAdapter } from "../core/adapter.ts";
import {
  deriveReleaseIndex,
  diffBrowserReleases,
  type BrowserRelease,
  type ReleaseIndex,
} from "../core/browser-releases/diff.ts";

export const BROWSER_RELEASES_SOURCE_ID = "browser-releases";

/** The published artifacts this differ observes (§5.3), one per browser. */
export const CHROME_RELEASES_URL =
  "https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Windows&num=1";
export const FIREFOX_VERSIONS_URL = "https://product-details.mozilla.org/1.0/firefox_versions.json";
export const SAFARI_RELEASES_URL = "https://developer.apple.com/news/releases/rss/releases.rss";

interface ChromeRelease {
  version: string;
  milestone: number;
  time: number;
}

export const parseChromeReleases = (payload: ChromeRelease[]): BrowserRelease | null => {
  const latest = payload[0];
  if (!latest) return null;
  return {
    browser: "chrome",
    version: latest.version,
    releasedAt: new Date(latest.time).toISOString().slice(0, 10),
    url: `https://developer.chrome.com/release-notes/${latest.milestone}`,
  };
};

interface FirefoxVersions {
  LATEST_FIREFOX_VERSION?: string;
}

/** product-details dates the last major release only, so point releases carry no date. */
export const parseFirefoxVersions = (payload: FirefoxVersions): BrowserRelease | null => {
  const version = payload.LATEST_FIREFOX_VERSION;
  if (!version) return null;
  return {
    browser: "firefox",
    version,
    releasedAt: null,
    url: `https://www.mozilla.org/firefox/${version}/releasenotes/`,
  };
};

/**
 * Stable Safari items are titled "Safari 26.2 (26620.2.5.11.5)"; betas
 * and Technology Previews carry extra words before the parenthesis and
 * fall outside this match. The feed is newest-first, so the first match
 * is the latest stable release.
 */
const SAFARI_TITLE = /^Safari (\d+(?:\.\d+)*)(?: \([^)]*\))?$/;

/** Apple's pubDate uses US zone abbreviations Date.parse does not accept. */
const ZONE_OFFSETS: Record<string, string> = { PDT: "-0700", PST: "-0800" };

const parsePubDate = (pubDate: string | undefined): string | null => {
  if (pubDate === undefined) return null;
  const normalized = pubDate.replace(/\b(PDT|PST)$/, (zone) => ZONE_OFFSETS[zone] ?? zone);
  const time = Date.parse(normalized);
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
};

interface FeedItem {
  title?: unknown;
  link?: unknown;
  pubDate?: unknown;
}

export const parseSafariFeed = (xml: string): BrowserRelease | null => {
  const feed = new XMLParser().parse(xml) as {
    rss?: { channel?: { item?: FeedItem | FeedItem[] } };
  };
  const items = feed.rss?.channel?.item;
  for (const item of Array.isArray(items) ? items : items ? [items] : []) {
    if (typeof item.title !== "string") continue;
    const match = SAFARI_TITLE.exec(item.title.trim());
    if (!match) continue;
    return {
      browser: "safari",
      version: match[1]!,
      releasedAt: parsePubDate(typeof item.pubDate === "string" ? item.pubDate : undefined),
      url: typeof item.link === "string" ? item.link : SAFARI_RELEASES_URL,
    };
  }
  return null;
};

const fetchJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} fetch failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
};

const fetchText = async (url: string): Promise<string> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} fetch failed: ${response.status} ${response.statusText}`);
  }
  return response.text();
};

export const fetchBrowserReleases = async (): Promise<BrowserRelease[]> => {
  const releases = await Promise.all([
    fetchJson<ChromeRelease[]>(CHROME_RELEASES_URL).then(parseChromeReleases),
    fetchJson<FirefoxVersions>(FIREFOX_VERSIONS_URL).then(parseFirefoxVersions),
    fetchText(SAFARI_RELEASES_URL).then(parseSafariFeed),
  ]);
  return releases.filter((release) => release !== null);
};

export interface BrowserReleasesAdapterOptions {
  fetchReleases: () => Promise<BrowserRelease[]>;
  now?: () => Date;
}

export const createBrowserReleasesAdapter = (
  options: BrowserReleasesAdapterOptions,
): SourceAdapter<ReleaseIndex> => {
  const now = options.now ?? (() => new Date());
  return {
    sourceId: BROWSER_RELEASES_SOURCE_ID,
    kind: "artifact-diff",
    run: async (cursor) => {
      const releases = await options.fetchReleases();
      const current = now();
      const events = diffBrowserReleases(cursor, releases, {
        now: current,
        observedAt: current.toISOString(),
      });
      // The cursor only advances for browsers this run observed, so a
      // feed that yields no stable item cannot erase another's memory.
      return { events, cursor: { ...cursor, ...deriveReleaseIndex(releases) } };
    },
  };
};
