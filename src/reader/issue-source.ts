// Slice G.5 (#69): the curation view's data seam, beside digest-source.ts.
//
// Reads go through PostgREST as the signed-in `authenticated` role and writes
// through the four SQL functions from migration 10. None of the access rules
// live here: the database decides who the operator is (`is_operator_request`),
// what a draft is, and which edits are legal. This module only asks, and maps
// what comes back to types the view can render.
import type { SupabaseClient } from "@supabase/supabase-js";
import { orderForDigest } from "../core/digest.ts";
import { sectionFor, type Section } from "../core/issue.ts";
import type { ChangeEvent } from "../core/types.ts";
import { CHANGE_EVENT_SELECT, iso, toEvent, type ChangeEventRow } from "./digest-source.ts";

/** One event of the draft's window, with what the issue says about it. */
export interface CurationEvent {
  event: ChangeEvent;
  /** False for an event that never had an `issue_item` row; including it inserts one. */
  hasRow: boolean;
  included: boolean;
  section: Section;
  /** Empty string, not null, when un-annotated: the form edits text. */
  note: string;
}

export interface CurationDraft {
  id: string;
  number: number;
  title: string;
  intro: string;
  windowStart: string;
  windowEnd: string;
  /** Included events first, then the rest in `orderForDigest` order. */
  events: CurationEvent[];
}

/**
 * What /curate can show, told apart by what the database answered:
 * - `signed-out`: there is no session, so nothing was asked.
 * - `not-operator`: a session exists but `is_operator_request()` is false, so
 *   the `authenticated` role would read no rows and every write would be a 42501.
 *   It carries the signed-in account's auth user id, which the operator needs to
 *   run `operator link`, and nothing else about the account.
 * - `no-draft`: the operator is signed in and no issue is open.
 */
export type CurationState =
  | { status: "signed-out" }
  | { status: "not-operator"; userId: string }
  | { status: "no-draft" }
  | { status: "draft"; draft: CurationDraft };

interface IssueItemRow {
  event_id: string;
  position: number;
  section: Section;
  note: string | null;
  included: boolean;
}

/** The nested row PostgREST returns for the draft query below. */
export interface IssueRow {
  id: string;
  number: number;
  title: string;
  intro: string;
  window_start: string;
  window_end: string;
  issue_item: IssueItemRow[];
}

const ISSUE_SELECT = `
  id, number, title, intro, window_start, window_end,
  issue_item ( event_id, position, section, note, included )
`;

/** Supabase's default `max_rows` is 1000, so a window is read a page at a time. */
const PAGE_SIZE = 1000;

/**
 * Shapes the draft and its window's events for the view.
 *
 * Order is decided here, once: included events first, then everything else as
 * `orderForDigest` ranks a digest. `Array.prototype.sort` is stable, so
 * partitioning on `included` keeps each half in digest order.
 */
export const toCurationDraft = (issue: IssueRow, eventRows: ChangeEventRow[]): CurationDraft => {
  const items = new Map(issue.issue_item.map((item) => [item.event_id, item]));
  const events = orderForDigest(eventRows.map(toEvent)).map((event): CurationEvent => {
    const item = items.get(event.id);
    return {
      event,
      hasRow: item !== undefined,
      included: item?.included ?? false,
      // The section the database assigns on include, so the select shows the
      // truth before and after the first save.
      section: item?.section ?? sectionFor(event, false),
      note: item?.note ?? "",
    };
  });
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    intro: issue.intro,
    windowStart: iso(issue.window_start),
    windowEnd: iso(issue.window_end),
    events: [...events.filter((e) => e.included), ...events.filter((e) => !e.included)],
  };
};

const fetchWindowEvents = async (
  client: SupabaseClient,
  windowStart: string,
  windowEnd: string,
): Promise<ChangeEventRow[]> => {
  const rows: ChangeEventRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    // The window is half-open, the range `issue open` selects from and
    // `issue_include_event` enforces. The raw timestamps are passed through
    // rather than round-tripped through Date, which would drop microseconds.
    const { data, error } = await client
      .from("change_event")
      .select(CHANGE_EVENT_SELECT)
      .gte("first_observed_at", windowStart)
      .lt("first_observed_at", windowEnd)
      // A stable order is what makes consecutive ranges disjoint.
      .order("id")
      .range(from, from + PAGE_SIZE - 1)
      .overrideTypes<ChangeEventRow[], { merge: false }>();
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
};

/**
 * Loads whatever /curate should show for the client's current session.
 *
 * "Is this the operator" is asked of the database, not inferred from an empty
 * result: an `authenticated` account that is not the operator and an operator
 * with no draft both read zero `issue` rows, and the two need different
 * messages. A failed read throws, so the view can say it failed rather than
 * showing "no draft" for an outage.
 */
export const fetchCuration = async (client: SupabaseClient): Promise<CurationState> => {
  const { data: sessionData } = await client.auth.getSession();
  if (!sessionData.session) return { status: "signed-out" };

  const operator = await client.rpc("is_operator_request");
  if (operator.error) throw new Error(operator.error.message);
  if (operator.data !== true)
    return { status: "not-operator", userId: sessionData.session.user.id };

  const { data: issue, error } = await client
    .from("issue")
    .select(ISSUE_SELECT)
    .eq("status", "draft")
    .maybeSingle<IssueRow>();
  if (error) throw new Error(error.message);
  if (!issue) return { status: "no-draft" };

  const events = await fetchWindowEvents(client, issue.window_start, issue.window_end);
  return { status: "draft", draft: toCurationDraft(issue, events) };
};

/**
 * The outcome of one write. `not-operator` is Postgres' insufficient-privilege
 * code (42501), which `issue_require_curator` raises when the signed-in
 * account is not the operator; it is told apart so the view can say so
 * instead of showing a database message.
 */
export type WriteResult =
  | { ok: true }
  | { ok: false; reason: "not-operator" | "failed"; message: string };

const INSUFFICIENT_PRIVILEGE = "42501";

const write = async (
  call: PromiseLike<{ error: { code: string; message: string } | null }>,
): Promise<WriteResult> => {
  try {
    const { error } = await call;
    if (!error) return { ok: true };
    return {
      ok: false,
      reason: error.code === INSUFFICIENT_PRIVILEGE ? "not-operator" : "failed",
      message: error.message,
    };
  } catch {
    // supabase-js reports most failures in `error`; a rejection means the
    // request itself could not be made.
    return {
      ok: false,
      reason: "failed",
      message: "The request could not be sent. Check your connection.",
    };
  }
};

export const includeEvent = (client: SupabaseClient, issueId: string, eventId: string) =>
  write(client.rpc("issue_include_event", { target_issue: issueId, target_event: eventId }));

export const excludeEvent = (client: SupabaseClient, issueId: string, eventId: string) =>
  write(client.rpc("issue_exclude_event", { target_issue: issueId, target_event: eventId }));

/**
 * What the operator changed about an item. A field that is absent is sent as
 * null, which the database function reads as "leave it as it is", so a save
 * from a page that has gone stale cannot overwrite the field it did not touch.
 */
export interface NoteChange {
  note?: string;
  section?: Section;
}

export const saveNote = (
  client: SupabaseClient,
  issueId: string,
  eventId: string,
  change: NoteChange,
) =>
  write(
    client.rpc("issue_annotate_item", {
      target_issue: issueId,
      target_event: eventId,
      new_note: change.note ?? null,
      new_section: change.section ?? null,
    }),
  );

/** The same rule for the heading: only a field that changed is sent. */
export interface HeadingChange {
  title?: string;
  intro?: string;
}

export const saveHeading = (client: SupabaseClient, issueId: string, change: HeadingChange) =>
  write(
    client.rpc("issue_set_heading", {
      target_issue: issueId,
      new_title: change.title ?? null,
      new_intro: change.intro ?? null,
    }),
  );
