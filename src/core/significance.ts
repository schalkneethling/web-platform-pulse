import { CHROME_STATUS } from "./chrome-status/diff.ts";
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
    case "tag-review": {
      // Low-volume and high-signal by nature (§ Slice B): a review opening
      // is worth surfacing, but a review the TAG has actually judged
      // outranks it — and a contested verdict outranks a routine one.
      const after = event.after as { state?: unknown; verdict?: unknown };
      if (after.state !== "closed") return 0.55;
      const verdict = typeof after.verdict === "string" ? after.verdict : null;
      if (verdict === "unsatisfied" || verdict === "object" || verdict === "decline") return 0.8;
      if (verdict === "satisfied" || verdict === "satisfied with concerns") return 0.65;
      return 0.6;
    }
    case "vendor-position": {
      // A vendor coming out against a proposal is bigger news than a
      // routine endorsement; hedges (neutral, defer, blocked) sink.
      const position = (event.after as { position?: unknown }).position;
      if (position === "oppose" || position === "negative") return 0.75;
      if (position === "support" || position === "positive") return 0.65;
      return 0.45;
    }
    case "feature-status": {
      // Breaking changes outrank shipping; trials outrank paperwork
      // stages (proposed, in development), which sink below stable
      // browser releases.
      const status = (event.after as { status?: unknown }).status;
      if (status === CHROME_STATUS.deprecated || status === CHROME_STATUS.removed) return 0.7;
      if (status === CHROME_STATUS.shipped) return 0.6;
      if (status === CHROME_STATUS.originTrial) return 0.5;
      if (status === CHROME_STATUS.devTrial) return 0.35;
      return 0.25;
    }
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
      // Voices posts are commentary, not platform change (§ Slice C): a
      // modest, fixed score that clears the noisiest pre-release channel
      // churn (canary/nightly/dev, 0.2) so the section actually surfaces
      // in a digest otherwise dominated by nightly browser releases, but
      // stays well below any real spec, feature, or stable-release event.
      return 0.35;
  }
};
