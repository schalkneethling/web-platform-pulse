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
    expect(parseChromeReleases(JSON.parse(fixture("chromium-dash.json")), "stable")).toEqual({
      browser: "chrome",
      channel: "stable",
      version: "149.0.7827.201",
      releasedAt: "2026-06-24",
      url: "https://developer.chrome.com/release-notes/149",
    });
  });

  it("points non-stable channels at the releases dashboard", () => {
    const release = parseChromeReleases(JSON.parse(fixture("chromium-dash.json")), "canary");
    expect(release).toMatchObject({
      channel: "canary",
      url: "https://chromiumdash.appspot.com/releases?platform=Windows",
    });
  });

  it("returns null for an empty payload", () => {
    expect(parseChromeReleases([], "stable")).toBeNull();
  });
});

describe("parseFirefoxVersions", () => {
  it("takes stable, beta and nightly versions, undated", () => {
    expect(parseFirefoxVersions(JSON.parse(fixture("firefox-versions.json")))).toEqual([
      {
        browser: "firefox",
        channel: "stable",
        version: "152.0.4",
        releasedAt: null,
        url: "https://www.mozilla.org/firefox/152.0.4/releasenotes/",
      },
      {
        browser: "firefox",
        channel: "beta",
        version: "153.0b7",
        releasedAt: null,
        url: "https://www.mozilla.org/firefox/153.0beta/releasenotes/",
      },
      {
        browser: "firefox",
        channel: "nightly",
        version: "154.0a1",
        releasedAt: null,
        url: "https://www.mozilla.org/firefox/nightly/notes/",
      },
    ]);
  });
});

describe("parseSafariFeed", () => {
  it("takes the latest item per channel: stable, beta and Technology Preview", () => {
    const releases = parseSafariFeed(fixture("releases.rss"));
    const byChannel = new Map(releases.map((release) => [release.channel, release]));
    expect(byChannel.get("stable")).toEqual({
      browser: "safari",
      channel: "stable",
      version: "26.1",
      releasedAt: "2026-06-15",
      url: "https://developer.apple.com/news/releases/?id=06152026c",
    });
    expect(byChannel.get("beta")).toMatchObject({
      version: "26.2 beta",
      releasedAt: "2026-06-22",
    });
    expect(byChannel.get("preview")).toMatchObject({
      version: "231",
      releasedAt: "2026-06-25",
    });
  });

  it("other Apple OS items never match", () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>iOS 26.6 beta 3 (23G5052d)</title></item>
      <item><title>macOS 26.6 beta 3 (25G5052e)</title></item>
    </channel></rss>`;
    expect(parseSafariFeed(xml)).toEqual([]);
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
    expect(cursor).toEqual({
      "chrome:stable": "148.0.7800.100",
      "firefox:stable": "151.0",
      "firefox:nightly": "153.0a1",
      "safari:stable": "26.1",
    });
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
      "browser-releases:release:chrome:stable:149.0.7827.201",
      "browser-releases:release:firefox:nightly:154.0a1",
      "browser-releases:release:firefox:stable:152.0",
    ]);
    expect(cursor["safari:stable"]).toBe("26.1");
  });

  it("a feed yielding no release leaves that channel's cursor untouched", async () => {
    const adapter = createBrowserReleasesAdapter({
      fetchReleases: () => Promise.resolve(loadReleases("new.json").slice(0, 1)),
      now: () => NOW,
    });
    const { cursor } = await adapter.run({
      "chrome:stable": "148.0.7800.100",
      "safari:stable": "26.1",
    });
    expect(cursor).toEqual({ "chrome:stable": "149.0.7827.201", "safari:stable": "26.1" });
  });
});
