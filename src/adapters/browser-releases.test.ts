import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import type { BrowserRelease } from "../core/browser-releases/diff.ts";
import {
  createBrowserReleasesAdapter,
  parseChromeReleases,
  parseFirefoxVersions,
  parseSafariFeed,
} from "./browser-releases.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../tests/fixtures/browser-releases/${name}`, import.meta.url), "utf8");

const loadReleases = (name: string): BrowserRelease[] =>
  JSON.parse(fixture(name)) as BrowserRelease[];

const NOW = new Date("2026-06-10T12:00:00Z");

describe("parseChromeReleases", () => {
  it("takes the newest stable release with its milestone notes URL", () => {
    expect(parseChromeReleases(JSON.parse(fixture("chromium-dash.json")))).toEqual({
      browser: "chrome",
      version: "149.0.7827.201",
      releasedAt: "2026-06-24",
      url: "https://developer.chrome.com/release-notes/149",
    });
  });

  it("returns null for an empty payload", () => {
    expect(parseChromeReleases([])).toBeNull();
  });
});

describe("parseFirefoxVersions", () => {
  it("takes the latest stable version, undated", () => {
    expect(parseFirefoxVersions(JSON.parse(fixture("firefox-versions.json")))).toEqual({
      browser: "firefox",
      version: "152.0.4",
      releasedAt: null,
      url: "https://www.mozilla.org/firefox/152.0.4/releasenotes/",
    });
  });
});

describe("parseSafariFeed", () => {
  it("skips betas, Technology Previews and other OS items to find stable Safari", () => {
    expect(parseSafariFeed(fixture("releases.rss"))).toEqual({
      browser: "safari",
      version: "26.1",
      releasedAt: "2026-06-15",
      url: "https://developer.apple.com/news/releases/?id=06152026c",
    });
  });

  it("returns null when the feed carries no stable Safari item", () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>iOS 26.6 beta 3 (23G5052d)</title></item>
    </channel></rss>`;
    expect(parseSafariFeed(xml)).toBeNull();
  });
});

describe("browser-releases adapter", () => {
  it("seeds silently on first run and returns the version index as cursor (§5.3)", async () => {
    const adapter = createBrowserReleasesAdapter({
      fetchReleases: () => Promise.resolve(loadReleases("old.json")),
      now: () => NOW,
    });
    const { events, cursor } = await adapter.run(null);
    expect(events).toEqual([]);
    expect(cursor).toEqual({ chrome: "148.0.7800.100", firefox: "151.0", safari: "26.1" });
  });

  it("emits the delta between cursor and fetched releases on subsequent runs", async () => {
    const seeded = await createBrowserReleasesAdapter({
      fetchReleases: () => Promise.resolve(loadReleases("old.json")),
      now: () => NOW,
    }).run(null);

    const { events, cursor } = await createBrowserReleasesAdapter({
      fetchReleases: () => Promise.resolve(loadReleases("new.json")),
      now: () => NOW,
    }).run(seeded.cursor);

    expect(events.map((e) => e.dedupeKey).sort()).toEqual([
      "browser-releases:release:chrome:149.0.7827.201",
      "browser-releases:release:firefox:152.0",
    ]);
    expect(cursor.safari).toBe("26.1");
  });

  it("a feed yielding no release leaves that browser's cursor untouched", async () => {
    const adapter = createBrowserReleasesAdapter({
      fetchReleases: () => Promise.resolve(loadReleases("new.json").slice(0, 1)),
      now: () => NOW,
    });
    const { cursor } = await adapter.run({ chrome: "148.0.7800.100", safari: "26.1" });
    expect(cursor).toEqual({ chrome: "149.0.7827.201", safari: "26.1" });
  });
});
