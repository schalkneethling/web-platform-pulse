import { sectionFor, type Section } from "../core/issue.ts";
import { orderForDigest } from "../core/digest.ts";
import type { ChangeEvent } from "../core/types.ts";
import type { Queryable, Sql } from "./db.ts";
import {
  CADENCE_PERIOD_MS,
  eventsWithProvenance,
  rowToEvent,
  type ChangeEventRow,
} from "./store.ts";

/** How many of the window's top-ranked events `issue open` pre-fills. */
export const ISSUE_PREFILL_LIMIT = 12;

export interface IssueItemView {
  position: number;
  section: Section;
  /** Null or blank means un-annotated. */
  note: string | null;
  included: boolean;
  event: ChangeEvent;
}

export interface IssueView {
  id: string;
  number: number;
  title: string;
  intro: string;
  status: "draft" | "published";
  windowStart: string;
  windowEnd: string;
  items: IssueItemView[];
}

export interface OpenResult {
  /** False when a draft already existed and nothing was written. */
  created: boolean;
  issueId: string;
}

/**
 * `issue open`: cut the next draft, or report the one that is already open.
 *
 * At most one draft exists (a partial unique index enforces it), so a second
 * open while one is in progress changes nothing. A new issue's window ends at
 * `now` and starts where the previous issue's ended, so a skipped week gives a
 * longer window instead of losing events between issues. The first issue looks
 * back one weekly period. Candidates are every event first observed in the
 * window, with no subscription filter: an issue is one artifact for everyone.
 * This never writes to `change_event`.
 */
export const openIssue = async (sql: Sql, now: Date = new Date()): Promise<OpenResult> => {
  return sql.begin(async (tx) => {
    const existing = await tx<{ id: string }[]>`select id from issue where status = 'draft'`;
    if (existing[0]) return { created: false, issueId: existing[0].id };

    const latest = await tx<{ number: number; window_end: Date }[]>`
      select number, window_end from issue order by number desc limit 1
    `;
    const windowStart =
      latest[0]?.window_end ?? new Date(now.getTime() - CADENCE_PERIOD_MS["weekly"]!);
    const number = (latest[0]?.number ?? 0) + 1;

    const issues = await tx<{ id: string }[]>`
      insert into issue (number, window_start, window_end)
      values (${number}, ${windowStart}, ${now})
      returning id
    `;
    const issueId = issues[0]!.id;

    const rows = await tx<ChangeEventRow[]>`
      select * from change_event
      where first_observed_at >= ${windowStart} and first_observed_at < ${now}
    `;
    // Provenance is not needed to rank, so skip the per-event lookup: a busy
    // window holds hundreds of events and only the top few become items.
    const ranked = orderForDigest(rows.map((row) => rowToEvent(row, []))).slice(
      0,
      ISSUE_PREFILL_LIMIT,
    );
    for (const [index, event] of ranked.entries()) {
      await tx`
        insert into issue_item (issue_id, event_id, position, section)
        values (${issueId}, ${event.id}, ${index + 1}, ${sectionFor(event, index === 0)})
      `;
    }
    return { created: true, issueId };
  });
};

interface IssueRow {
  id: string;
  number: number;
  title: string;
  intro: string;
  status: "draft" | "published";
  window_start: Date;
  window_end: Date;
}

interface IssueItemRow {
  event_id: string;
  position: number;
  section: Section;
  note: string | null;
  included: boolean;
}

const issueView = async (sql: Queryable, issue: IssueRow): Promise<IssueView> => {
  const items = await sql<IssueItemRow[]>`
    select event_id, position, section, note, included
    from issue_item where issue_id = ${issue.id} order by position
  `;
  const rows = await sql<ChangeEventRow[]>`
    select * from change_event where id = any(${items.map((item) => item.event_id)}::uuid[])
  `;
  const events = new Map((await eventsWithProvenance(sql, rows)).map((event) => [event.id, event]));
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    intro: issue.intro,
    status: issue.status,
    windowStart: issue.window_start.toISOString(),
    windowEnd: issue.window_end.toISOString(),
    items: items.map((item) => ({
      position: item.position,
      section: item.section,
      note: item.note,
      included: item.included,
      event: events.get(item.event_id)!,
    })),
  };
};

/** The open draft with its items joined to their events, or null when none is open. */
export const getDraftIssue = async (sql: Sql): Promise<IssueView | null> => {
  const issues = await sql<IssueRow[]>`
    select id, number, title, intro, status, window_start, window_end
    from issue where status = 'draft'
  `;
  return issues[0] ? issueView(sql, issues[0]) : null;
};
