import { describe, expect, it } from "vite-plus/test";
import { deriveReleaseIndex, diffBrowserReleases, type BrowserRelease } from "./diff.ts";

const NOW = new Date("2026-06-10T12:00:00Z");
const OPTIONS = { now: NOW, observedAt: NOW.toISOString() };

const release = (overrides: Partial<BrowserRelease>): BrowserRelease => ({
  browser: "chrome",
  channel: "stable",
  version: "149.0.7827.201",
  releasedAt: "2026-06-08",
  url: "https://developer.chrome.com/release-notes/149",
  ...overrides,
});

describe("diffBrowserReleases", () => {
  it("cold-starts silently, emitting only releases dated within the window (§5.3)", () => {
    const releases = [
      release({ releasedAt: "2026-06-08" }),
      release({ browser: "firefox", version: "152.0", releasedAt: null }),
      release({ browser: "safari", version: "26.1", releasedAt: "2026-05-13" }),
    ];
    const events = diffBrowserReleases(null, releases, OPTIONS);
    expect(events.map((e) => e.dedupeKey)).toEqual([
      "browser-releases:release:chrome:stable:149.0.7827.201",
    ]);
    expect(events[0]!.before).toBeNull();
  });

  it("emits a release when the cursor holds an older version", () => {
    const prev = { "chrome:stable": "148.0.7800.100", "firefox:stable": "152.0" };
    const events = diffBrowserReleases(prev, [release({})], OPTIONS);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "browser-release",
      subject: { kind: "browser", name: "chrome", version: "149.0.7827.201" },
      title: "Chrome 149.0.7827.201 released",
      before: { version: "148.0.7800.100", channel: "stable" },
      after: { version: "149.0.7827.201", channel: "stable" },
      occurredAt: "2026-06-08",
      taxonomy: ["browser"],
    });
    expect(events[0]!.provenance[0]!.url).toBe("https://developer.chrome.com/release-notes/149");
  });

  it("emits nothing when versions match the cursor", () => {
    const prev = { "chrome:stable": "149.0.7827.201" };
    expect(diffBrowserReleases(prev, [release({})], OPTIONS)).toEqual([]);
  });

  it("tracks channels of the same browser independently", () => {
    const prev = { "chrome:stable": "149.0.7827.201", "chrome:canary": "151.0.7900.0" };
    const events = diffBrowserReleases(
      prev,
      [release({}), release({ channel: "canary", version: "151.0.7901.0" })],
      OPTIONS,
    );
    expect(events.map((e) => e.dedupeKey)).toEqual([
      "browser-releases:release:chrome:canary:151.0.7901.0",
    ]);
    expect(events[0]!.title).toBe("Chrome Canary 151.0.7901.0 released");
  });

  it("labels non-stable channels: Nightly, Beta and Technology Preview", () => {
    const events = diffBrowserReleases(
      {},
      [
        release({ browser: "firefox", channel: "nightly", version: "154.0a1" }),
        release({ browser: "safari", channel: "preview", version: "231" }),
      ],
      OPTIONS,
    );
    expect(events.map((e) => e.title)).toEqual([
      "Firefox Nightly 154.0a1 released",
      "Safari Technology Preview 231 released",
    ]);
  });

  it("a channel missing from the cursor emits with a null before", () => {
    const events = diffBrowserReleases(
      { "chrome:stable": "149.0.7827.201" },
      [release({ browser: "safari", version: "26.1", releasedAt: "2026-06-09" })],
      OPTIONS,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.before).toBeNull();
  });
});

describe("deriveReleaseIndex", () => {
  it("maps each browser and channel to its observed version", () => {
    expect(
      deriveReleaseIndex([
        release({}),
        release({ channel: "canary", version: "151.0.7901.0" }),
        release({ browser: "firefox", version: "152.0" }),
      ]),
    ).toEqual({
      "chrome:stable": "149.0.7827.201",
      "chrome:canary": "151.0.7901.0",
      "firefox:stable": "152.0",
    });
  });
});
