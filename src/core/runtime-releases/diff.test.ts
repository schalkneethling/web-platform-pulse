import { describe, expect, it } from "vite-plus/test";
import { deriveRuntimeIndex, diffRuntimeReleases, type RuntimeRelease } from "./diff.ts";

const NOW = new Date("2026-06-10T12:00:00Z");
const OPTIONS = { now: NOW, observedAt: NOW.toISOString() };

const release = (overrides: Partial<RuntimeRelease>): RuntimeRelease => ({
  runtime: "node",
  line: "current",
  version: "26.3.0",
  releasedAt: "2026-06-08",
  url: "https://nodejs.org/en/blog/release/v26.3.0",
  ...overrides,
});

describe("diffRuntimeReleases", () => {
  it("cold-starts silently, emitting only releases dated within the window (§5.3)", () => {
    const releases = [
      release({}),
      release({ runtime: "bun", line: "stable", version: "1.3.13", releasedAt: "2026-05-13" }),
      release({ runtime: "deno", line: "stable", version: "2.8.0", releasedAt: null }),
    ];
    const events = diffRuntimeReleases(null, releases, OPTIONS);
    expect(events.map((e) => e.dedupeKey)).toEqual([
      "runtime-releases:release:node:current:26.3.0",
    ]);
    expect(events[0]!.before).toBeNull();
  });

  it("emits a release when the cursor holds an older version", () => {
    const prev = { "node:current": "26.2.0" };
    const events = diffRuntimeReleases(prev, [release({})], OPTIONS);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "runtime-release",
      subject: { kind: "runtime", name: "node", version: "26.3.0" },
      title: "Node.js 26.3.0 released",
      before: { version: "26.2.0", line: "current" },
      after: { version: "26.3.0", line: "current" },
      occurredAt: "2026-06-08",
      taxonomy: ["runtime"],
    });
  });

  it("tracks Node's Current and LTS lines independently, labelling LTS", () => {
    const prev = { "node:current": "26.3.0", "node:lts": "24.11.0" };
    const events = diffRuntimeReleases(
      prev,
      [release({}), release({ line: "lts", version: "24.12.0", releasedAt: "2026-06-10" })],
      OPTIONS,
    );
    expect(events.map((e) => e.title)).toEqual(["Node.js 24.12.0 (LTS) released"]);
    expect(events[0]!.dedupeKey).toBe("runtime-releases:release:node:lts:24.12.0");
  });

  it("emits nothing when versions match the cursor", () => {
    const prev = { "node:current": "26.3.0" };
    expect(diffRuntimeReleases(prev, [release({})], OPTIONS)).toEqual([]);
  });
});

describe("deriveRuntimeIndex", () => {
  it("maps each runtime and line to its observed version", () => {
    expect(
      deriveRuntimeIndex([
        release({}),
        release({ line: "lts", version: "24.12.0" }),
        release({ runtime: "bun", line: "stable", version: "1.3.14" }),
      ]),
    ).toEqual({
      "node:current": "26.3.0",
      "node:lts": "24.12.0",
      "bun:stable": "1.3.14",
    });
  });
});
