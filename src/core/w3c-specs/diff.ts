import type { CandidateEvent } from "../types.ts";

/**
 * One W3C rec-track spec, normalized from browser-specs (shortname, title,
 * working groups) joined with its latest api.w3.org version (status, date,
 * editors, deliverers). `status` keeps the W3C process vocabulary
 * ("Working Draft", "Candidate Recommendation Draft", "Recommendation", …).
 */
export interface W3CSpec {
  /** browser-specs shortname — also the api.w3.org specification id. */
  shortname: string;
  title: string;
  status: string;
  /** api.w3.org's `date` for this version — the transition date. */
  date: string | null;
  url: string;
  /** Working/interest groups from browser-specs; api.w3.org calls these deliverers. */
  groups: string[];
  editors: string[];
}

/** The cursor: the last status seen per spec shortname. */
export type W3CSpecIndex = Record<string, string>;

const SOURCE_ID = "w3c-specs";

/**
 * The W3C process stages this differ phrases; the one source of truth so
 * digest lines cannot drift from the api.w3.org vocabulary.
 */
export const W3C_STATUS = {
  note: "Note",
  draftNote: "Draft Note",
  draftRegistry: "Draft Registry",
  statement: "Statement",
  discontinued: "Discontinued Draft",
  fpwd: "First Public Working Draft",
  workingDraft: "Working Draft",
  crDraft: "Candidate Recommendation Draft",
  crSnapshot: "Candidate Recommendation Snapshot",
  recommendation: "Recommendation",
} as const;

/** Short forms for the handful of stages worth abbreviating in a digest line. */
const STATUS_ABBREVIATIONS: Record<string, string> = {
  [W3C_STATUS.crDraft]: "CR",
  [W3C_STATUS.crSnapshot]: "CR",
};

const statusLabel = (status: string): string => STATUS_ABBREVIATIONS[status] ?? status;

const groupsLabel = (groups: string[]): string => groups.join(" and ");

const editorsLabel = (editors: string[]): string => {
  if (editors.length === 0) return "";
  if (editors.length <= 3) return `edited by ${editors.join(", ")}`;
  return `edited by ${editors.slice(0, 3).join(", ")}, and others`;
};

/** "(CSS Working Group; edited by …)", "(CSS Working Group)", or "" when both are unknown. */
const attributionSuffix = (spec: W3CSpec): string => {
  const parts = [groupsLabel(spec.groups), editorsLabel(spec.editors)].filter(
    (part) => part !== "",
  );
  return parts.length > 0 ? ` (${parts.join("; ")})` : "";
};

const specTitle = (spec: W3CSpec): string =>
  `${spec.title} advanced to ${statusLabel(spec.status)}${attributionSuffix(spec)}`;

/** Working-group names are a finer signal than the spec-URL heuristic (§9). */
const themeFromGroups = (groups: string[]): string => {
  const lowered = groups.map((group) => group.toLowerCase());
  if (lowered.some((group) => group.includes("css"))) return "css";
  if (lowered.some((group) => group.includes("html") || group.includes("web applications"))) {
    return "html";
  }
  if (lowered.some((group) => group.includes("ecmascript") || group.includes("javascript"))) {
    return "javascript";
  }
  return "api";
};

const statusSlug = (status: string): string =>
  status
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

export const deriveW3CSpecIndex = (specs: W3CSpec[]): W3CSpecIndex => {
  const index: W3CSpecIndex = {};
  for (const spec of specs) {
    index[spec.shortname] = spec.status;
  }
  return index;
};

const specCandidate = (
  spec: W3CSpec,
  before: string | null,
  observedAt: string,
): CandidateEvent => {
  const title = specTitle(spec);
  // Keyed by transition, not destination: a spec can revisit a stage (a
  // second CR after wide review finds issues), and a destination-only key
  // would collide with the earlier event's dedupe_key and swallow this one.
  const transition = `${statusSlug(before ?? "unseen")}-to-${statusSlug(spec.status)}`;
  return {
    type: "spec-change",
    subject: { kind: "spec", shortname: spec.shortname },
    title,
    before: before === null ? null : { status: before },
    after: {
      status: spec.status,
      groups: spec.groups,
      editors: spec.editors,
      specUrl: spec.url,
    },
    // api.w3.org's date is the version's publication date — the real
    // transition date, unlike sources with no dated window to replay.
    occurredAt: spec.date,
    taxonomy: [themeFromGroups(spec.groups)],
    dedupeKey: `w3c-specs:spec:${spec.shortname}:${transition}`,
    correlationKey: `spec-change:${spec.shortname}:${transition}`,
    provenance: [{ sourceId: SOURCE_ID, url: spec.url, title, observedAt }],
  };
};

/**
 * Cold start (§5.3): the first run has no cursor to diff against, so it
 * seeds every known spec's status silently — no events, since there is no
 * dated window to replay — and events flow from the next status change on.
 */
export const diffW3CSpecs = (
  prev: W3CSpecIndex | null,
  specs: W3CSpec[],
  options: { observedAt: string },
): CandidateEvent[] => {
  if (prev === null) return [];

  const events: CandidateEvent[] = [];
  for (const spec of specs) {
    const before = prev[spec.shortname] ?? null;
    if (before === spec.status) continue;
    events.push(specCandidate(spec, before, options.observedAt));
  }
  return events;
};
