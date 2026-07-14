import type { SourceAdapter } from "../core/adapter.ts";
import {
  deriveTagReviewIndex,
  diffTagReviews,
  type TagReview,
  type TagReviewIndex,
} from "../core/tag-reviews/diff.ts";
import { fetchWithTimeout } from "./http.ts";

export const TAG_REVIEWS_SOURCE_ID = "tag-reviews";

/** The published artifact this differ observes (§5.3): every issue, open and closed. */
export const TAG_REVIEWS_ISSUES_URL = "https://api.github.com/repos/w3ctag/design-reviews/issues";

const PAGE_SIZE = 100;
/** ~13 pages for a full fetch today (§ NEXT_STEPS); the cap bounds a runaway loop. */
const MAX_PAGES = 40;

/** The Resolution: <verdict> label is the TAG's own vocabulary for a review's outcome. */
const RESOLUTION_LABEL_PREFIX = "Resolution: ";

interface GithubLabel {
  name?: unknown;
}

interface GithubIssue {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  html_url?: unknown;
  updated_at?: unknown;
  pull_request?: unknown;
  labels?: GithubLabel[];
}

/** The first Resolution: label wins; the TAG does not stack more than one. */
const verdictFromLabels = (labels: GithubLabel[] | undefined): string | null => {
  for (const label of labels ?? []) {
    if (typeof label.name === "string" && label.name.startsWith(RESOLUTION_LABEL_PREFIX)) {
      return label.name.slice(RESOLUTION_LABEL_PREFIX.length);
    }
  }
  return null;
};

export const parseTagReviews = (payload: GithubIssue[]): TagReview[] => {
  const reviews: TagReview[] = [];
  for (const entry of payload) {
    // The issues API also returns pull requests opened against the repo
    // (rare, but possible); design reviews are issues only.
    if (entry.pull_request !== undefined) continue;
    if (typeof entry.number !== "number" || typeof entry.title !== "string") continue;
    if (entry.state !== "open" && entry.state !== "closed") continue;
    reviews.push({
      number: entry.number,
      title: entry.title,
      state: entry.state,
      verdict: verdictFromLabels(entry.labels),
      url:
        typeof entry.html_url === "string"
          ? entry.html_url
          : `https://github.com/w3ctag/design-reviews/issues/${entry.number}`,
      updatedAt: typeof entry.updated_at === "string" ? entry.updated_at.slice(0, 10) : null,
    });
  }
  return reviews;
};

/** Actions' GITHUB_TOKEN lifts the unauthenticated api.github.com rate limit. */
const githubHeaders = (): Record<string, string> => {
  const token = process.env.GITHUB_TOKEN;
  return {
    Accept: "application/vnd.github+json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
};

/** GitHub's Link header carries the next page's URL; a missing rel="next" ends the dump. */
const nextPageUrl = (linkHeader: string | null): string | null => {
  if (linkHeader === null) return null;
  for (const part of linkHeader.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (match) return match[1] ?? null;
  }
  return null;
};

const fetchPage = async (url: string): Promise<{ issues: GithubIssue[]; next: string | null }> => {
  const response = await fetchWithTimeout(url, { headers: githubHeaders() });
  if (!response.ok) {
    throw new Error(`${url} fetch failed: ${response.status} ${response.statusText}`);
  }
  const issues = (await response.json()) as GithubIssue[];
  return { issues, next: nextPageUrl(response.headers.get("link")) };
};

/**
 * Walks every page GitHub links via `rel="next"` rather than trusting a
 * fixed page count — the API's cursor pagination carries no total, so a
 * missing Link header is the only honest end-of-dump signal (§ chrome-status
 * analog: a short page or absent total ends the loop, not a guess).
 */
export const fetchTagReviews = async (): Promise<TagReview[]> => {
  const reviews: TagReview[] = [];
  let url: string | null = `${TAG_REVIEWS_ISSUES_URL}?state=all&per_page=${PAGE_SIZE}`;
  for (let page = 0; page < MAX_PAGES && url !== null; page += 1) {
    const { issues, next } = await fetchPage(url);
    reviews.push(...parseTagReviews(issues));
    url = next;
  }
  if (url !== null) {
    // Truncation is survivable — the cursor only advances for reviews
    // this run observed — but it should not be silent.
    console.warn(`tag-reviews: dump still paginating after ${MAX_PAGES} pages; results truncated`);
  }
  return reviews;
};

export interface TagReviewsAdapterOptions {
  fetchReviews: () => Promise<TagReview[]>;
  now?: () => Date;
}

export const createTagReviewsAdapter = (
  options: TagReviewsAdapterOptions,
): SourceAdapter<TagReviewIndex> => {
  const now = options.now ?? (() => new Date());
  return {
    sourceId: TAG_REVIEWS_SOURCE_ID,
    kind: "artifact-diff",
    run: async (cursor) => {
      const reviews = await options.fetchReviews();
      const events = diffTagReviews(cursor, reviews, { observedAt: now().toISOString() });
      // The cursor only advances for reviews this run observed, so a
      // truncated dump cannot erase another review's memory.
      return { events, cursor: { ...cursor, ...deriveTagReviewIndex(reviews) } };
    },
  };
};
