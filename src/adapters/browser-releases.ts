import { XMLParser } from "fast-xml-parser";
import type { SourceAdapter } from "../core/adapter.ts";
import {
  deriveReleaseIndex,
  diffBrowserReleases,
  type BrowserRelease,
  type ReleaseChannel,
  type ReleaseIndex,
} from "../core/browser-releases/diff.ts";

export const BROWSER_RELEASES_SOURCE_ID = "browser-releases";

/** The published artifacts this differ observes (§5.3), one per browser. */
export const chromeReleasesUrl = (channel: string): string =>
  `https://chromiumdash.appspot.com/fetch_releases?channel=${channel}&platform=Windows&num=1`;
export const FIREFOX_VERSIONS_URL = "https://product-details.mozilla.org/1.0/firefox_versions.json";
export const SAFARI_RELEASES_URL = "https://developer.apple.com/news/releases/rss/releases.rss";

/** Chromium Dash channel names, mapped to the channel vocabulary here. */
const CHROME_CHANNELS: [ReleaseChannel, string][] = [
  ["stable", "Stable"],
  ["beta", "Beta"],
  ["dev", "Dev"],
  ["canary", "Canary"],
];

interface ChromeRelease {
  version: string;
  milestone: number;
  time: number;
}

export const parseChromeReleases = (
  payload: ChromeRelease[],
  channel: ReleaseChannel,
): BrowserRelease | null => {
  const latest = payload[0];
  if (!latest) return null;
  return {
    browser: "chrome",
    channel,
    version: latest.version,
    releasedAt: new Date(latest.time).toISOString().slice(0, 10),
    // Milestone release notes exist for stable only.
    url:
      channel === "stable"
        ? `https://developer.chrome.com/release-notes/${latest.milestone}`
        : "https://chromiumdash.appspot.com/releases?platform=Windows",
  };
};

interface FirefoxVersions {
  LATEST_FIREFOX_VERSION?: string;
  LATEST_FIREFOX_DEVEL_VERSION?: string;
  FIREFOX_NIGHTLY?: string;
}

/** Beta notes live at ".../153.0beta/releasenotes/" for version "153.0b7". */
const firefoxNotesUrl = (channel: ReleaseChannel, version: string): string => {
  if (channel === "nightly") return "https://www.mozilla.org/firefox/nightly/notes/";
  const slug = channel === "beta" ? version.replace(/b\d+$/, "beta") : version;
  return `https://www.mozilla.org/firefox/${slug}/releasenotes/`;
};

/** product-details dates the last major release only, so versions carry no date. */
export const parseFirefoxVersions = (payload: FirefoxVersions): BrowserRelease[] => {
  const channels: [ReleaseChannel, string | undefined][] = [
    ["stable", payload.LATEST_FIREFOX_VERSION],
    ["beta", payload.LATEST_FIREFOX_DEVEL_VERSION],
    ["nightly", payload.FIREFOX_NIGHTLY],
  ];
  return channels
    .filter((entry): entry is [ReleaseChannel, string] => Boolean(entry[1]))
    .map(([channel, version]) => ({
      browser: "firefox",
      channel,
      version,
      releasedAt: null,
      url: firefoxNotesUrl(channel, version),
    }));
};

/**
 * Safari items by title shape: "Safari 26.1 (26620.2.5.11.5)" is stable,
 * "Safari 26.2 beta 3 (26621.1.4.2)" is beta (the beta number is part of
 * the version, so beta 3 → beta 4 is a release), and "Safari Technology
 * Preview 231" is the preview channel. The feed is newest-first, so the
 * first match per channel is that channel's latest.
 */
const SAFARI_TITLES: [ReleaseChannel, RegExp][] = [
  ["stable", /^Safari (\d+(?:\.\d+)*)(?: \([^)]*\))?$/],
  ["beta", /^Safari (\d+(?:\.\d+)* beta(?: \d+)?)(?: \([^)]*\))?$/],
  ["preview", /^Safari Technology Preview (\d+)$/],
];

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

export const parseSafariFeed = (xml: string): BrowserRelease[] => {
  const feed = new XMLParser().parse(xml) as {
    rss?: { channel?: { item?: FeedItem | FeedItem[] } };
  };
  const items = feed.rss?.channel?.item;
  const found = new Map<ReleaseChannel, BrowserRelease>();
  for (const item of Array.isArray(items) ? items : items ? [items] : []) {
    if (typeof item.title !== "string") continue;
    const title = item.title.trim();
    for (const [channel, pattern] of SAFARI_TITLES) {
      if (found.has(channel)) continue;
      const match = pattern.exec(title);
      if (!match) continue;
      found.set(channel, {
        browser: "safari",
        channel,
        version: match[1]!,
        releasedAt: parsePubDate(typeof item.pubDate === "string" ? item.pubDate : undefined),
        url: typeof item.link === "string" ? item.link : SAFARI_RELEASES_URL,
      });
    }
  }
  return [...found.values()];
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
  const [chrome, firefox, safari] = await Promise.all([
    Promise.all(
      CHROME_CHANNELS.map(async ([channel, name]) =>
        parseChromeReleases(await fetchJson<ChromeRelease[]>(chromeReleasesUrl(name)), channel),
      ),
    ),
    fetchJson<FirefoxVersions>(FIREFOX_VERSIONS_URL).then(parseFirefoxVersions),
    fetchText(SAFARI_RELEASES_URL).then(parseSafariFeed),
  ]);
  return [...chrome.filter((release) => release !== null), ...firefox, ...safari];
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
      // The cursor only advances for channels this run observed, so a
      // feed that yields no item cannot erase another channel's memory.
      return { events, cursor: { ...cursor, ...deriveReleaseIndex(releases) } };
    },
  };
};
