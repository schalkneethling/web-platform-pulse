import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import type { TagReview } from "../core/tag-reviews/diff.ts";
import {
  createTagReviewsAdapter,
  fetchTagReviews,
  parseTagReviews,
  TAG_REVIEWS_ISSUES_URL,
} from "./tag-reviews.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../tests/fixtures/tag-reviews/${name}`, import.meta.url), "utf8");

const loadReviews = (name: string): TagReview[] => JSON.parse(fixture(name)) as TagReview[];

describe("parseTagReviews", () => {
  it("derives the verdict from the Resolution: label", () => {
    const reviews = parseTagReviews(JSON.parse(fixture("issues-page-1.json")));
    const bidi = reviews.find((r) => r.number === 1230);
    expect(bidi).toMatchObject({ state: "closed", verdict: "satisfied" });
  });

  it("carries verdict: null for a review with no Resolution: label", () => {
    const reviews = parseTagReviews(JSON.parse(fixture("issues-page-1.json")));
    const charter = reviews.find((r) => r.number === 1244);
    expect(charter).toMatchObject({ state: "open", verdict: null });
  });

  it("excludes pull requests the issues API also returns", () => {
    const reviews = parseTagReviews(JSON.parse(fixture("issues-page-1.json")));
    expect(reviews.some((r) => r.number === 9999)).toBe(false);
  });

  it("truncates updated_at to an ISO date", () => {
    const reviews = parseTagReviews(JSON.parse(fixture("issues-page-1.json")));
    expect(reviews.find((r) => r.number === 1244)?.updatedAt).toBe("2026-06-18");
  });
});

describe("fetchTagReviews", () => {
  it('follows the Link header across pages and stops when rel="next" is absent', async () => {
    const page1 = JSON.parse(fixture("issues-page-1.json"));
    const page2 = JSON.parse(fixture("issues-page-2.json"));
    const firstUrl = `${TAG_REVIEWS_ISSUES_URL}?state=all&per_page=100`;
    const secondUrl = `${TAG_REVIEWS_ISSUES_URL}?state=all&per_page=100&page=2`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === firstUrl) {
        return new Response(JSON.stringify(page1), {
          status: 200,
          headers: { link: `<${secondUrl}>; rel="next"` },
        });
      }
      if (url === secondUrl) {
        return new Response(JSON.stringify(page2), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const reviews = await fetchTagReviews();
      expect(reviews.map((r) => r.number)).toEqual([1244, 1230, 1227]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends an authorization header when GITHUB_TOKEN is set", async () => {
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";
    const originalFetch = globalThis.fetch;
    let sawAuthHeader = false;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      sawAuthHeader = headers?.authorization === "Bearer test-token";
      return new Response("[]", { status: 200 });
    }) as typeof fetch;

    try {
      await fetchTagReviews();
      expect(sawAuthHeader).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalToken;
    }
  });

  it("warns and stops at the page cap instead of looping forever", async () => {
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = ((...args: unknown[]) => {
      warnings.push(args.join(" "));
    }) as typeof console.warn;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("[]", { status: 200, headers: { link: '<https://x/next>; rel="next"' } });
    }) as typeof fetch;

    try {
      await fetchTagReviews();
      expect(calls).toBe(40);
      expect(warnings.some((w) => w.includes("truncated"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
    }
  });
});

describe("tag-reviews adapter", () => {
  it("seeds silently on first run and returns the state/verdict index as cursor (§5.3)", async () => {
    const adapter = createTagReviewsAdapter({
      fetchReviews: () => Promise.resolve(loadReviews("old.json")),
    });
    const { events, cursor } = await adapter.run(null);
    expect(events).toEqual([]);
    expect(cursor).toEqual({
      1244: { state: "open", verdict: null },
      1230: { state: "open", verdict: null },
    });
  });

  it("emits a closed event with verdict when a review resolves", async () => {
    const seeded = await createTagReviewsAdapter({
      fetchReviews: () => Promise.resolve(loadReviews("old.json")),
    }).run(null);

    const { events, cursor } = await createTagReviewsAdapter({
      fetchReviews: () => Promise.resolve(loadReviews("new.json")),
    }).run(seeded.cursor);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tag-review",
      subject: { kind: "tag-review", number: 1230 },
      title: "TAG design review closed: WebDriver BiDi (satisfied)",
      occurredAt: "2026-06-03",
      taxonomy: ["api"],
    });
    expect(cursor[1230]).toEqual({ state: "closed", verdict: "satisfied" });
  });

  it("re-running with unchanged data is idempotent (zero new events)", async () => {
    const seeded = await createTagReviewsAdapter({
      fetchReviews: () => Promise.resolve(loadReviews("new.json")),
    }).run(null);

    const rerun = await createTagReviewsAdapter({
      fetchReviews: () => Promise.resolve(loadReviews("new.json")),
    }).run(seeded.cursor);

    expect(rerun.events).toEqual([]);
  });
});
