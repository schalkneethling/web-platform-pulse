import { describe, expect, it } from "vite-plus/test";
import { deriveVoicesIndex, diffVoices, sourceLabel, type VoicePost } from "./diff.ts";

const post = (overrides: Partial<VoicePost>): VoicePost => ({
  source: "webkit",
  title: "Introducing the Safari MCP server for web developers",
  url: "https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/",
  publishedAt: "2026-07-08",
  ...overrides,
});

const NOW = new Date("2026-07-10T12:00:00Z");
const OBSERVED_AT = NOW.toISOString();
const OPTIONS = { now: NOW, observedAt: OBSERVED_AT };

describe("diffVoices", () => {
  it("cold-starts, emitting only posts dated within the window (§5.3)", () => {
    const posts = [
      post({ publishedAt: "2026-07-08" }),
      post({ url: "https://webkit.org/old", publishedAt: "2026-05-01" }),
      post({ source: "igalia", url: "https://igalia.com/undated", publishedAt: null }),
    ];
    const events = diffVoices(null, posts, OPTIONS);
    expect(events.map((e) => e.dedupeKey)).toEqual([
      "voices:post:webkit:https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/",
    ]);
    expect(events[0]!.before).toBeNull();
  });

  it("a feed added after seeding gets its own cold-start window", () => {
    const prev = { webkit: ["https://webkit.org/blog/old-post/"] };
    const events = diffVoices(
      prev,
      [
        post({ source: "igalia", url: "https://igalia.com/fresh", publishedAt: "2026-07-09" }),
        post({ source: "igalia", url: "https://igalia.com/archive", publishedAt: "2024-01-15" }),
      ],
      OPTIONS,
    );
    expect(events.map((e) => e.dedupeKey)).toEqual(["voices:post:igalia:https://igalia.com/fresh"]);
  });

  it("emits a post the cursor has not seen for this source", () => {
    const prev = { webkit: ["https://webkit.org/blog/old-post/"] };
    const events = diffVoices(prev, [post({})], OPTIONS);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "editorial",
      subject: {
        kind: "post",
        source: "webkit",
        url: "https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/",
      },
      title: "Introducing the Safari MCP server for web developers",
      before: null,
      after: {
        source: "webkit",
        url: "https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/",
      },
      occurredAt: "2026-07-08",
      taxonomy: ["voices"],
    });
    expect(events[0]!.provenance[0]).toMatchObject({
      sourceId: "voices",
      url: "https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/",
      title: "WebKit Blog: Introducing the Safari MCP server for web developers",
      observedAt: OBSERVED_AT,
    });
  });

  it("is idempotent: a post already in the cursor is not re-emitted", () => {
    const prev = {
      webkit: [
        "https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/",
      ],
    };
    expect(diffVoices(prev, [post({})], OPTIONS)).toEqual([]);
  });

  it("tracks sources independently, so a shared cursor never cross-matches URLs", () => {
    const prev = {
      igalia: [
        "https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/",
      ],
    };
    const events = diffVoices(prev, [post({})], OPTIONS);
    expect(events).toHaveLength(1);
  });

  it("a re-run over unchanged feeds emits zero new events", () => {
    const stale = post({ publishedAt: "2026-05-01" });
    const first = diffVoices(null, [stale], OPTIONS);
    expect(first).toHaveLength(0); // cold start: outside the window, seeded silently
    const seeded = deriveVoicesIndex(null, [stale]);
    const second = diffVoices(seeded, [stale], OPTIONS);
    expect(second).toHaveLength(0);
  });

  it("uses the post title verbatim, with no synthetic wording", () => {
    const events = diffVoices({}, [post({ title: "A Wrap on the Hackfest" })], OPTIONS);
    expect(events[0]!.title).toBe("A Wrap on the Hackfest");
  });
});

describe("deriveVoicesIndex", () => {
  it("keys seen post URLs by source", () => {
    const index = deriveVoicesIndex(null, [
      post({}),
      post({ source: "igalia", url: "https://igalia.com/a" }),
    ]);
    expect(index).toEqual({
      webkit: [
        "https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/",
      ],
      igalia: ["https://igalia.com/a"],
    });
  });

  it("accumulates across runs rather than replacing the prior set", () => {
    const first = deriveVoicesIndex(null, [post({ url: "https://webkit.org/a" })]);
    const second = deriveVoicesIndex(first, [post({ url: "https://webkit.org/b" })]);
    expect(second.webkit).toEqual(
      expect.arrayContaining(["https://webkit.org/a", "https://webkit.org/b"]),
    );
    expect(second.webkit).toHaveLength(2);
  });
});

describe("sourceLabel", () => {
  it("maps known source slugs to display names", () => {
    expect(sourceLabel("webkit")).toBe("WebKit Blog");
    expect(sourceLabel("mozilla-hacks")).toBe("Mozilla Hacks");
  });

  it("falls back to the slug itself for an unknown source", () => {
    expect(sourceLabel("chromium")).toBe("chromium");
  });
});
