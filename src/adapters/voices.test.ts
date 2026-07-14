import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import type { VoicePost } from "../core/voices/diff.ts";
import { createVoicesAdapter, fetchVoicePosts, parseVoicesFeed, VOICES_FEEDS } from "./voices.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../tests/fixtures/voices/${name}`, import.meta.url), "utf8");

const loadPosts = (name: string): VoicePost[] => JSON.parse(fixture(name)) as VoicePost[];

const NOW = new Date("2026-07-14T12:00:00Z");

describe("parseVoicesFeed", () => {
  it("parses an RSS 2.0 feed into dated posts", () => {
    expect(parseVoicesFeed(fixture("webkit.rss"), "webkit")).toEqual([
      {
        source: "webkit",
        title: "Release Notes for Safari Technology Preview 231",
        url: "https://webkit.org/blog/17301/release-notes-for-safari-technology-preview-231/",
        publishedAt: "2026-07-10",
      },
      {
        source: "webkit",
        title: "Anchor positioning in WebKit",
        url: "https://webkit.org/blog/17280/anchor-positioning-in-webkit/",
        publishedAt: "2026-06-30",
      },
    ]);
  });

  it("parses an Atom feed, preferring the rel=alternate link and published date", () => {
    expect(parseVoicesFeed(fixture("igalia.atom"), "igalia")).toEqual([
      {
        source: "igalia",
        title: "Servo in 2026: mid-year update",
        url: "https://www.igalia.com/2026/07/09/servo-mid-year.html",
        publishedAt: "2026-07-09",
      },
      {
        source: "igalia",
        title: "CSS highlight inheritance lands in Chromium",
        url: "https://www.igalia.com/2026/06/22/highlight-inheritance.html",
        publishedAt: "2026-06-22",
      },
    ]);
  });
});

describe("fetchVoicePosts", () => {
  it("one failing feed does not sink the others", async () => {
    const webkitUrl = VOICES_FEEDS.find((feed) => feed.source === "webkit")!.url;
    const realFetch = globalThis.fetch;
    const realWarn = console.warn;
    const warnings: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === webkitUrl) {
        return new Response(fixture("webkit.rss"), { status: 200 });
      }
      return new Response("gone", { status: 503, statusText: "Service Unavailable" });
    }) as typeof fetch;
    console.warn = (message: string) => {
      warnings.push(message);
    };
    try {
      const posts = await fetchVoicePosts();
      expect(posts.map((post) => post.source)).toEqual(["webkit", "webkit"]);
      // Every other feed's failure is reported, not swallowed.
      expect(warnings).toHaveLength(VOICES_FEEDS.length - 1);
    } finally {
      globalThis.fetch = realFetch;
      console.warn = realWarn;
    }
  });
});

describe("voices adapter", () => {
  it("cold start seeds silently, emitting only posts within the window (§5.3)", async () => {
    const adapter = createVoicesAdapter({
      fetchPosts: () => Promise.resolve(loadPosts("new.json")),
      now: () => NOW,
    });
    const { events, cursor } = await adapter.run(null);
    // The 30 June and 22 June posts predate the 7-day window; only the
    // fresh pair surfaces in the first digest.
    expect(events.map((e) => e.dedupeKey).sort()).toEqual([
      "voices:post:igalia:https://www.igalia.com/2026/07/09/servo-mid-year.html",
      "voices:post:webkit:https://webkit.org/blog/17301/release-notes-for-safari-technology-preview-231/",
    ]);
    expect(cursor.webkit).toHaveLength(2);
    expect(cursor.igalia).toHaveLength(2);
  });

  it("emits each post exactly once across runs", async () => {
    const seeded = await createVoicesAdapter({
      fetchPosts: () => Promise.resolve(loadPosts("old.json")),
      now: () => NOW,
    }).run(null);

    const { events } = await createVoicesAdapter({
      fetchPosts: () => Promise.resolve(loadPosts("new.json")),
      now: () => NOW,
    }).run(seeded.cursor);

    expect(events.map((e) => e.dedupeKey).sort()).toEqual([
      "voices:post:igalia:https://www.igalia.com/2026/07/09/servo-mid-year.html",
      "voices:post:webkit:https://webkit.org/blog/17301/release-notes-for-safari-technology-preview-231/",
    ]);
    expect(events.every((e) => e.type === "editorial" && e.taxonomy[0] === "voices")).toBe(true);
  });

  it("a re-run over unchanged feeds is idempotent", async () => {
    const adapter = createVoicesAdapter({
      fetchPosts: () => Promise.resolve(loadPosts("new.json")),
      now: () => NOW,
    });
    const first = await adapter.run(null);
    const second = await adapter.run(first.cursor);
    expect(second.events).toEqual([]);
    expect(second.cursor).toEqual(first.cursor);
  });

  it("a feed yielding nothing cannot erase another source's memory", async () => {
    const adapter = createVoicesAdapter({
      fetchPosts: () => Promise.resolve(loadPosts("new.json").filter((p) => p.source === "webkit")),
      now: () => NOW,
    });
    const seeded = await createVoicesAdapter({
      fetchPosts: () => Promise.resolve(loadPosts("old.json")),
      now: () => NOW,
    }).run(null);
    const { cursor } = await adapter.run(seeded.cursor);
    expect(cursor.igalia).toEqual(["https://www.igalia.com/2026/06/22/highlight-inheritance.html"]);
    expect(cursor.webkit).toHaveLength(2);
  });
});
