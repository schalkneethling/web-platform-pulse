import { XMLParser } from "fast-xml-parser";
import type { SourceAdapter } from "../core/adapter.ts";
import {
  deriveVoicesIndex,
  diffVoices,
  type VoicePost,
  type VoicesIndex,
} from "../core/voices/diff.ts";

export const VOICES_SOURCE_ID = "voices";

/**
 * The verified-live feeds this differ observes (§ Slice C): vendor and
 * standards-body blogs, aggregated as their own digest section rather than
 * matched to change events — feed data alone (title + URL) makes matching
 * fuzzy, so that idea stays deferred (see NEXT_STEPS.md).
 */
export const VOICES_FEEDS: { source: string; url: string }[] = [
  { source: "webkit", url: "https://webkit.org/feed/" },
  { source: "igalia", url: "https://www.igalia.com/feed.xml" },
  { source: "mozilla-hacks", url: "https://hacks.mozilla.org/feed/" },
  { source: "w3c", url: "https://www.w3.org/blog/feed/" },
  { source: "whatwg", url: "https://blog.whatwg.org/feed" },
];

/** A hung feed request must not stall the whole run. */
const FETCH_TIMEOUT_MS = 10_000;

interface RssItem {
  title?: unknown;
  link?: unknown;
  guid?: unknown;
  pubDate?: unknown;
}

interface AtomLink {
  "@_href"?: unknown;
  "@_rel"?: unknown;
}

interface AtomEntry {
  title?: unknown;
  link?: AtomLink | AtomLink[];
  id?: unknown;
  published?: unknown;
  updated?: unknown;
}

const toArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const toIsoDate = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
};

/** RSS 2.0, used by WebKit, Mozilla Hacks, the W3C blog, and the WHATWG blog. */
const parseRssFeed = (xml: string, source: string): VoicePost[] => {
  const feed = new XMLParser({ ignoreAttributes: false }).parse(xml) as {
    rss?: { channel?: { item?: RssItem | RssItem[] } };
  };
  const posts: VoicePost[] = [];
  for (const item of toArray(feed.rss?.channel?.item)) {
    if (typeof item.title !== "string" || typeof item.link !== "string") continue;
    posts.push({
      source,
      title: item.title.trim(),
      url: item.link.trim(),
      publishedAt: toIsoDate(typeof item.pubDate === "string" ? item.pubDate : undefined),
    });
  }
  return posts;
};

/** Atom 1.0, used by Igalia. */
const parseAtomFeed = (xml: string, source: string): VoicePost[] => {
  const feed = new XMLParser({ ignoreAttributes: false }).parse(xml) as {
    feed?: { entry?: AtomEntry | AtomEntry[] };
  };
  const posts: VoicePost[] = [];
  for (const entry of toArray(feed.feed?.entry)) {
    if (typeof entry.title !== "string") continue;
    const links = toArray(entry.link);
    const alternate = links.find((link) => link["@_rel"] === "alternate") ?? links[0];
    const href = alternate?.["@_href"];
    if (typeof href !== "string") continue;
    const published = typeof entry.published === "string" ? entry.published : entry.updated;
    posts.push({
      source,
      title: entry.title.trim(),
      url: href.trim(),
      publishedAt: toIsoDate(typeof published === "string" ? published : undefined),
    });
  }
  return posts;
};

/** Atom declares its root as `<feed>`; RSS as `<rss>`. Cheaper than a second parse. */
const isAtomFeed = (xml: string): boolean => /<feed[\s>]/.test(xml) && !/<rss[\s>]/.test(xml);

export const parseVoicesFeed = (xml: string, source: string): VoicePost[] =>
  isAtomFeed(xml) ? parseAtomFeed(xml, source) : parseRssFeed(xml, source);

const fetchText = async (url: string): Promise<string> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`${url} fetch failed: ${response.status} ${response.statusText}`);
  }
  return response.text();
};

/**
 * Fetches every feed independently: one dead or slow blog must not sink
 * the others (§ Slice C, same spirit as w3c-specs' per-spec isolation) —
 * log and skip it, and its posts simply wait for a future run once the
 * feed recovers.
 */
export const fetchVoicePosts = async (): Promise<VoicePost[]> => {
  const results = await Promise.all(
    VOICES_FEEDS.map(async ({ source, url }) => {
      try {
        return parseVoicesFeed(await fetchText(url), source);
      } catch (error) {
        console.warn(`voices: skipping ${source}: ${(error as Error).message}`);
        return [];
      }
    }),
  );
  return results.flat();
};

export interface VoicesAdapterOptions {
  fetchPosts: () => Promise<VoicePost[]>;
  now?: () => Date;
}

export const createVoicesAdapter = (options: VoicesAdapterOptions): SourceAdapter<VoicesIndex> => {
  const now = options.now ?? (() => new Date());
  return {
    sourceId: VOICES_SOURCE_ID,
    kind: "artifact-diff",
    run: async (cursor) => {
      const posts = await options.fetchPosts();
      const current = now();
      const events = diffVoices(cursor, posts, { now: current, observedAt: current.toISOString() });
      // The cursor only grows with posts this run observed, so a feed that
      // failed and returned nothing cannot erase another source's memory.
      return { events, cursor: deriveVoicesIndex(cursor, posts) };
    },
  };
};
