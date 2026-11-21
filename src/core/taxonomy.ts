import { THEME_ORDER } from "./themes.ts";

/**
 * The web-features `groups` object: each group's display name and, for a
 * nested group, the id of its parent. Roots such as `css` have no parent.
 */
export type GroupGraph = Record<string, { name?: string; parent?: string }>;

/** The roots that have a theme of their own; every other root is a Web API. */
const ROOT_THEMES = new Set(["css", "html", "javascript"]);

/**
 * Walks `parent` links from a group up to its root. The graph is data from
 * outside the project, so the walk survives two kinds of damage: a parent id
 * that is not in the graph ends the walk at the last group that is, and a
 * cycle ends it at the last group before the walk would repeat itself.
 */
export const rootOf = (groupId: string, graph: GroupGraph): string => {
  const seen = new Set<string>([groupId]);
  let current = groupId;
  for (;;) {
    const parent = graph[current]?.parent;
    if (parent === undefined || graph[parent] === undefined || seen.has(parent)) return current;
    seen.add(parent);
    current = parent;
  }
};

const themeOfRoot = (root: string): string => (ROOT_THEMES.has(root) ? root : "api");

/**
 * Maps each known group to the theme of its root and returns the distinct
 * themes in `THEME_ORDER` order, so the answer does not depend on the order
 * the groups arrive in. A group missing from the graph is ignored. An empty
 * result means "the graph has no answer", which is different from `["api"]`,
 * the answer for a group whose root is not CSS, HTML or JavaScript.
 */
export const themesForGroups = (groupIds: string[], graph: GroupGraph): string[] => {
  const themes = new Set<string>();
  for (const groupId of groupIds) {
    if (graph[groupId] === undefined) continue;
    themes.add(themeOfRoot(rootOf(groupId, graph)));
  }
  return THEME_ORDER.filter((theme) => themes.has(theme));
};

/**
 * The first-spec-URL heuristic the group graph replaced as the primary
 * source. It stays as the second step for features that belong to no group,
 * where it often still gives the right answer. Returns `[]` when the URL is
 * not one it recognises, so the caller can tell that apart from "api".
 */
export const themeFromSpecUrl = (spec: string[] = []): string[] => {
  const url = spec[0] ?? "";
  if (url.includes("csswg.org") || url.includes("fxtf.org")) return ["css"];
  if (url.includes("html.spec.whatwg.org")) return ["html"];
  if (url.includes("tc39.es")) return ["javascript"];
  if (url.includes("ecma-international.org")) return ["javascript"];
  return [];
};

interface TaxonomyInput {
  group?: string[];
  spec?: string[];
}

/**
 * Groups first, then the spec URL. Returns `[]` when neither has an answer,
 * for callers that have a better fallback of their own.
 */
export const themesForFeature = (feature: TaxonomyInput, graph: GroupGraph): string[] => {
  const fromGroups = themesForGroups(feature.group ?? [], graph);
  return fromGroups.length > 0 ? fromGroups : themeFromSpecUrl(feature.spec);
};

/**
 * The taxonomy stored on a web-features event. Issues 49 and 57 say an
 * ungrouped feature falls back to `api`. That would regress the features
 * with no group that the spec-URL heuristic classifies correctly today, so
 * the heuristic is the middle step and `api` only the last, which means no
 * feature ends with an empty taxonomy.
 */
export const deriveTaxonomy = (feature: TaxonomyInput, graph: GroupGraph): string[] => {
  const themes = themesForFeature(feature, graph);
  return themes.length > 0 ? themes : ["api"];
};
