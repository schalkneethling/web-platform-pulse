import { withinColdStartWindow } from "../cold-start.ts";
import type { CandidateEvent } from "../types.ts";

/** One first-party blog post, however its feed encodes it. */
export interface VoicePost {
  /** The vendor/standards-body blog this post came from. */
  source: string;
  title: string;
  url: string;
  /** ISO date (YYYY-MM-DD) when the feed carries one. */
  publishedAt: string | null;
}

/**
 * The cursor: post URLs already emitted, per source. This is aggregation,
 * not a status-per-key diff (§ Slice C) — a feed can carry many new posts
 * in one run, so the cursor is a *set* of seen keys rather than a single
 * "latest" value, and a post is diff material exactly once: the run it
 * first appears in.
 */
export type VoicesIndex = Record<string, string[]>;

const SOURCE_ID = "voices";

const SOURCE_LABELS: Record<string, string> = {
  webkit: "WebKit Blog",
  igalia: "Igalia",
  "mozilla-hacks": "Mozilla Hacks",
  w3c: "W3C Blog",
  whatwg: "WHATWG Blog",
};

export const sourceLabel = (source: string): string => SOURCE_LABELS[source] ?? source;

/** A post's dedupe key is its URL — stable across runs, unlike title text
 * that a source might tweak after publishing. */
const postKey = (post: VoicePost): string => post.url;

export const deriveVoicesIndex = (prev: VoicesIndex | null, posts: VoicePost[]): VoicesIndex => {
  const index: VoicesIndex = {};
  for (const [source, keys] of Object.entries(prev ?? {})) {
    index[source] = [...keys];
  }
  for (const post of posts) {
    const seen = new Set(index[post.source] ?? []);
    seen.add(postKey(post));
    index[post.source] = [...seen];
  }
  return index;
};

const postCandidate = (post: VoicePost, observedAt: string): CandidateEvent => {
  const label = sourceLabel(post.source);
  return {
    type: "editorial",
    subject: { kind: "post", source: post.source, url: post.url },
    title: post.title,
    before: null,
    after: { source: post.source, url: post.url },
    occurredAt: post.publishedAt,
    taxonomy: ["voices"],
    dedupeKey: `voices:post:${post.source}:${postKey(post)}`,
    correlationKey: `voices:post:${post.source}:${postKey(post)}`,
    provenance: [
      { sourceId: SOURCE_ID, url: post.url, title: `${label}: ${post.title}`, observedAt },
    ],
  };
};

/**
 * Cold start (§5.3): a source with no cursor yet — whether the whole
 * pipeline is new or the feed was added later — would otherwise flood the
 * digest with its archive, so — same spirit as browser-releases — only
 * posts dated within the cold-start window before now are emitted; the
 * rest are seeded into the cursor silently.
 */
export const diffVoices = (
  prev: VoicesIndex | null,
  posts: VoicePost[],
  options: { now: Date; observedAt: string },
): CandidateEvent[] => {
  const events: CandidateEvent[] = [];
  for (const post of posts) {
    const seen = prev?.[post.source];
    if (seen !== undefined && seen.includes(postKey(post))) continue;
    if (seen === undefined && !withinColdStartWindow(post.publishedAt, options.now)) continue;
    events.push(postCandidate(post, options.observedAt));
  }
  return events;
};
