import { describe, expect, it } from "vite-plus/test";
import { deriveReleaseIndex, diffBrowserReleases, type BrowserRelease } from "./diff.ts";

const NOW = new Date("2026-06-10T12:00:00Z");
const OPTIONS = { now: NOW, observedAt: NOW.toISOString() };

const release = (overrides: Partial<BrowserRelease>): BrowserRelease => ({
  browser: "chrome",
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
      "browser-releases:release:chrome:149.0.7827.201",
    ]);
    expect(events[0]!.before).toBeNull();
  });

  it("emits a release when the cursor holds an older version", () => {
    const prev = { chrome: "148.0.7800.100", firefox: "152.0", safari: "26.1" };
    const events = diffBrowserReleases(prev, [release({})], OPTIONS);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "browser-release",
      subject: { kind: "browser", name: "chrome", version: "149.0.7827.201" },
      title: "Chrome 149.0.7827.201 released",
      before: { version: "148.0.7800.100" },
      after: { version: "149.0.7827.201" },
      occurredAt: "2026-06-08",
      taxonomy: ["browser"],
    });
    expect(events[0]!.provenance[0]!.url).toBe("https://developer.chrome.com/release-notes/149");
  });

  it("emits nothing when versions match the cursor", () => {
    const prev = { chrome: "149.0.7827.201" };
    expect(diffBrowserReleases(prev, [release({})], OPTIONS)).toEqual([]);
  });

  it("a browser missing from the cursor emits with a null before", () => {
    const events = diffBrowserReleases(
      { chrome: "149.0.7827.201" },
      [release({ browser: "safari", version: "26.1", releasedAt: "2026-06-09" })],
      OPTIONS,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.before).toBeNull();
  });
});

describe("deriveReleaseIndex", () => {
  it("maps each browser to its observed version", () => {
    expect(
      deriveReleaseIndex([release({}), release({ browser: "firefox", version: "152.0" })]),
    ).toEqual({ chrome: "149.0.7827.201", firefox: "152.0" });
  });
});
