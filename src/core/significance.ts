import type { CandidateEvent } from "./types.ts";

/**
 * The v1 significance heuristic (§8.3): a transparent, tunable ranking
 * kept in one pure function so it can be replaced without touching the
 * pipeline. Scores are clamped to [0, 1].
 */
export const scoreSignificance = (event: CandidateEvent): number => {
  switch (event.type) {
    case "baseline-change": {
      const after = event.after as { baseline?: unknown };
      return after.baseline === "high" ? 0.9 : 0.7;
    }
    case "browser-support":
      return 0.4;
    case "runtime-release": {
      if (event.subject.kind !== "runtime") return 0.5;
      const match = /^(\d+)\.(\d+)\.(\d+)/.exec(event.subject.version);
      if (!match) return 0.3;
      if (match[2] === "0" && match[3] === "0") return 0.8;
      if (match[3] === "0") return 0.5;
      return 0.3;
    }
    case "spec-change":
      return 0.6;
    case "browser-release": {
      // Pre-release churn (canary and nightly ship daily) sinks to the
      // bottom of the group; only stable releases rank by version jump.
      const channel = (event.after as { channel?: unknown }).channel;
      if (channel === "canary" || channel === "nightly" || channel === "dev") return 0.2;
      if (channel === "beta" || channel === "preview") return 0.3;
      const majorOf = (value: unknown): string | null => {
        const version = (value as { version?: unknown } | null)?.version;
        return typeof version === "string" ? (version.split(".")[0] ?? null) : null;
      };
      const before = majorOf(event.before);
      const after = majorOf(event.after);
      if (before === null || after === null) return 0.5;
      return before === after ? 0.4 : 0.7;
    }
    case "editorial":
      return 0.5;
  }
};
