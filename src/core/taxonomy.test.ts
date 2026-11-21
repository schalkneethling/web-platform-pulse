import { describe, expect, it } from "vite-plus/test";
import {
  deriveTaxonomy,
  rootOf,
  themeFromSpecUrl,
  themesForFeature,
  themesForGroups,
  type GroupGraph,
} from "./taxonomy.ts";

const graph: GroupGraph = {
  css: { name: "CSS" },
  html: { name: "HTML" },
  javascript: { name: "JavaScript" },
  webgl: { name: "WebGL" },
  images: { name: "Images", parent: "css" },
  "image-scaling": { name: "Image scaling", parent: "images" },
  selectors: { name: "Selectors", parent: "css" },
  "webgl-extensions": { name: "WebGL extensions", parent: "webgl" },
  forms: { name: "Forms", parent: "html" },
};

describe("rootOf", () => {
  it("returns a root group as itself", () => {
    expect(rootOf("css", graph)).toBe("css");
  });

  it("walks one level up", () => {
    expect(rootOf("selectors", graph)).toBe("css");
  });

  it("walks two levels up", () => {
    expect(rootOf("image-scaling", graph)).toBe("css");
  });

  it("stops at the last known group when a parent is missing from the graph", () => {
    expect(rootOf("orphan", { orphan: { parent: "ghost" } })).toBe("orphan");
  });

  it("stops before repeating itself when the parents form a cycle", () => {
    const cyclic: GroupGraph = { a: { parent: "b" }, b: { parent: "a" } };
    expect(rootOf("a", cyclic)).toBe("b");
    expect(rootOf("b", cyclic)).toBe("a");
  });

  it("stops when a group is its own parent", () => {
    expect(rootOf("a", { a: { parent: "a" } })).toBe("a");
  });
});

describe("themesForGroups", () => {
  it("maps a nested CSS group to css", () => {
    expect(themesForGroups(["selectors"], graph)).toEqual(["css"]);
  });

  it("resolves a group two levels deep to its root's theme", () => {
    expect(themesForGroups(["image-scaling"], graph)).toEqual(["css"]);
  });

  it("maps html and javascript roots to themselves", () => {
    expect(themesForGroups(["forms"], graph)).toEqual(["html"]);
    expect(themesForGroups(["javascript"], graph)).toEqual(["javascript"]);
  });

  it("maps every other root to api", () => {
    expect(themesForGroups(["webgl-extensions"], graph)).toEqual(["api"]);
  });

  it("returns the distinct themes in theme order, whatever order the groups arrive in", () => {
    const forward = themesForGroups(["webgl", "forms", "selectors", "images"], graph);
    const backward = themesForGroups(["images", "selectors", "forms", "webgl"], graph);
    expect(forward).toEqual(["css", "html", "api"]);
    expect(backward).toEqual(forward);
  });

  it("returns [] for no groups and for groups the graph does not know", () => {
    expect(themesForGroups([], graph)).toEqual([]);
    expect(themesForGroups(["ghost"], graph)).toEqual([]);
  });

  it("ignores an unknown group next to a known one", () => {
    expect(themesForGroups(["ghost", "selectors"], graph)).toEqual(["css"]);
  });

  it("does not hang or throw on a cycle or a dangling parent", () => {
    const damaged: GroupGraph = {
      a: { parent: "b" },
      b: { parent: "a" },
      orphan: { parent: "ghost" },
    };
    expect(themesForGroups(["a", "orphan"], damaged)).toEqual(["api"]);
  });
});

describe("themeFromSpecUrl", () => {
  it.each([
    ["https://drafts.csswg.org/css-values-4/#lh", ["css"]],
    ["https://drafts.fxtf.org/filter-effects/", ["css"]],
    ["https://html.spec.whatwg.org/multipage/", ["html"]],
    ["https://tc39.es/ecma262/", ["javascript"]],
    ["https://www.ecma-international.org/publications/", ["javascript"]],
    ["https://w3c.github.io/uievents/", []],
  ])("classifies %s", (url, expected) => {
    expect(themeFromSpecUrl([url])).toEqual(expected);
  });

  it("only reads the first spec URL", () => {
    expect(themeFromSpecUrl(["https://example.com/", "https://tc39.es/ecma262/"])).toEqual([]);
  });

  it("returns [] for no spec", () => {
    expect(themeFromSpecUrl(undefined)).toEqual([]);
  });
});

describe("themesForFeature", () => {
  it("prefers the group graph over the spec URL", () => {
    expect(
      themesForFeature(
        { group: ["webgl"], spec: ["https://drafts.csswg.org/css-values-4/"] },
        graph,
      ),
    ).toEqual(["api"]);
  });

  it("returns [] when neither groups nor spec have an answer", () => {
    expect(themesForFeature({ spec: ["https://example.com/"] }, graph)).toEqual([]);
  });
});

describe("deriveTaxonomy", () => {
  it("uses the group graph when a known group answers", () => {
    expect(deriveTaxonomy({ group: ["selectors"] }, graph)).toEqual(["css"]);
  });

  it("gives a feature in groups under different roots the same taxonomy for both input orders", () => {
    expect(deriveTaxonomy({ group: ["forms", "selectors"] }, graph)).toEqual(["css", "html"]);
    expect(deriveTaxonomy({ group: ["selectors", "forms"] }, graph)).toEqual(["css", "html"]);
  });

  it("falls back to the spec URL when the feature has no group", () => {
    expect(deriveTaxonomy({ spec: ["https://tc39.es/ecma262/"] }, graph)).toEqual(["javascript"]);
  });

  it("treats an unknown group id like no group", () => {
    expect(deriveTaxonomy({ group: ["ghost"], spec: ["https://tc39.es/ecma262/"] }, graph)).toEqual(
      ["javascript"],
    );
  });

  it("falls back to api when there is no group and no recognised spec", () => {
    expect(deriveTaxonomy({}, graph)).toEqual(["api"]);
    expect(deriveTaxonomy({ spec: ["https://example.com/"] }, graph)).toEqual(["api"]);
  });
});
