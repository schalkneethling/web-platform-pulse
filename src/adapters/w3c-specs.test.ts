import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import type { W3CSpec } from "../core/w3c-specs/diff.ts";
import {
  createW3CSpecsAdapter,
  fetchW3CSpec,
  parseW3CRecTrackSpecs,
  type W3CRecTrackSpec,
} from "./w3c-specs.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../tests/fixtures/w3c-specs/${name}`, import.meta.url), "utf8");

const loadSpecs = (name: string): W3CSpec[] => JSON.parse(fixture(name)) as W3CSpec[];

describe("parseW3CRecTrackSpecs", () => {
  it("keeps only W3C entries that have been published to /TR/", () => {
    const specs = parseW3CRecTrackSpecs(JSON.parse(fixture("browser-specs-index.json")));
    expect(specs.map((s) => s.shortname)).toEqual(["css-color-5", "css-color-4"]);
  });

  it("carries title and working-group names for the allowlist entries", () => {
    const specs = parseW3CRecTrackSpecs(JSON.parse(fixture("browser-specs-index.json")));
    expect(specs[0]).toEqual({
      shortname: "css-color-5",
      title: "CSS Color Module Level 5",
      groups: ["Cascading Style Sheets (CSS) Working Group"],
    });
  });

  it("excludes non-W3C organizations even when a release is present", () => {
    const specs = parseW3CRecTrackSpecs(JSON.parse(fixture("browser-specs-index.json")));
    expect(specs.some((s) => s.shortname === "afgs1-spec")).toBe(false);
  });

  it("excludes W3C entries with no release (nightly-only drafts)", () => {
    const specs = parseW3CRecTrackSpecs(JSON.parse(fixture("browser-specs-index.json")));
    expect(specs.some((s) => s.shortname === "css-color-6")).toBe(false);
  });
});

describe("fetchW3CSpec", () => {
  const recTrackSpec: W3CRecTrackSpec = {
    shortname: "css-color-5",
    title: "CSS Color Module Level 5",
    groups: ["Cascading Style Sheets (CSS) Working Group"],
  };

  it("joins the version, editors, and deliverers resources into one spec", async () => {
    const responses: Record<string, unknown> = {
      "https://api.w3.org/specifications/css-color-5/versions/latest": JSON.parse(
        fixture("version-css-color-5.json"),
      ),
      "https://api.w3.org/specifications/css-color-5/versions/20260618/editors": JSON.parse(
        fixture("editors-css-color-5.json"),
      ),
      "https://api.w3.org/specifications/css-color-5/versions/20260618/deliverers": JSON.parse(
        fixture("deliverers-css-color-5.json"),
      ),
    };
    const urlOf = (input: RequestInfo | URL): string =>
      input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      const body = responses[url];
      if (body === undefined) throw new Error(`unexpected fetch: ${url}`);
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    try {
      const spec = await fetchW3CSpec(recTrackSpec);
      expect(spec).toEqual({
        shortname: "css-color-5",
        title: "CSS Color Module Level 5",
        status: "Working Draft",
        date: "2026-06-18",
        url: "https://www.w3.org/TR/2026/WD-css-color-5-20260618/",
        groups: ["Cascading Style Sheets (CSS) Working Group"],
        editors: ["Chris Lilley", "Una Kravets", "Lea Verou"],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns null when api.w3.org has no record of the spec (404)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    try {
      const spec = await fetchW3CSpec(recTrackSpec);
      expect(spec).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("w3c-specs adapter", () => {
  it("seeds silently on first run and returns the status index as cursor (§5.3)", async () => {
    const adapter = createW3CSpecsAdapter({
      fetchSpecs: () => Promise.resolve(loadSpecs("old.json")),
    });
    const { events, cursor } = await adapter.run(null);
    expect(events).toEqual([]);
    expect(cursor).toEqual({
      "css-color-5": "Working Draft",
      "css-color-4": "Candidate Recommendation Draft",
    });
  });

  it("emits a spec-change event on status transition, dated from the API's date field", async () => {
    const seeded = await createW3CSpecsAdapter({
      fetchSpecs: () => Promise.resolve(loadSpecs("old.json")),
    }).run(null);

    const { events, cursor } = await createW3CSpecsAdapter({
      fetchSpecs: () => Promise.resolve(loadSpecs("new.json")),
    }).run(seeded.cursor);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "spec-change",
      subject: { kind: "spec", shortname: "css-color-4" },
      title:
        "CSS Color Module Level 4 advanced to CR (Cascading Style Sheets (CSS) Working Group; " +
        "edited by Chris Lilley, Tab Atkins Jr., Lea Verou)",
      occurredAt: "2026-06-18",
      taxonomy: ["css"],
    });
    expect(cursor["css-color-4"]).toBe("Candidate Recommendation Snapshot");
  });

  it("a fetch that skipped a spec leaves its cursor entry untouched", async () => {
    const adapter = createW3CSpecsAdapter({
      fetchSpecs: () => Promise.resolve(loadSpecs("new.json").slice(0, 1)),
    });
    const { cursor } = await adapter.run({
      "css-color-5": "Working Draft",
      "css-color-4": "Candidate Recommendation Draft",
    });
    expect(cursor).toEqual({
      "css-color-5": "Working Draft",
      "css-color-4": "Candidate Recommendation Draft",
    });
  });
});
