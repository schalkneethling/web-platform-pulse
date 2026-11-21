import { sectionFor, type Section } from "../core/issue.ts";
import { orderForDigest } from "../core/digest.ts";
import type { DeliveryResult } from "../core/delivery.ts";
import type { ChangeEvent } from "../core/types.ts";
import type { Queryable, Sql } from "./db.ts";
import {
  CADENCE_PERIOD_MS,
  eventsWithProvenance,
  MAX_FAILED_DELIVERIES,
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

/**
 * Publishes the open draft with one statement guarded by `status = 'draft'`, so
 * two concurrent publishes cannot both flip it and `published_at` is stamped
 * once.
 *
 * The same statement refuses a draft that is not ready to send: it needs a
 * title, and at least one included item or an intro. The title rule is what
 * stops an untouched draft from going out. `issue open` pre-fills a draft with
 * a blank title, so a draft nobody has edited can never be published by
 * mistake, however it was reached. The rule lives in the `where` clause, not in
 * the caller, so no other code path can publish around it.
 *
 * The three outcomes are told apart with a read after the update, which is safe
 * because a draft only ever leaves that state through this function.
 */
export type PublishResult =
  | { outcome: "published"; id: string; number: number }
  | { outcome: "refused"; number: number; missing: PublishRequirement[] }
  | { outcome: "no-draft" };

/** What a refused draft still needs: the two halves of the publish guard. */
export type PublishRequirement = "title" | "content";

export const publishDraft = async (sql: Sql): Promise<PublishResult> => {
  const published = await sql<{ id: string; number: number }[]>`
    update issue set status = 'published', published_at = now()
    where status = 'draft'
      and btrim(title) <> ''
      and (
        btrim(intro) <> ''
        or exists (
          select 1 from issue_item where issue_item.issue_id = issue.id and issue_item.included
        )
      )
    returning id, number
  `;
  if (published[0]) {
    return { outcome: "published", id: published[0].id, number: published[0].number };
  }
  const drafts = await sql<{ number: number; no_title: boolean; no_content: boolean }[]>`
    select number,
      btrim(title) = '' as no_title,
      btrim(intro) = '' and not exists (
        select 1 from issue_item where issue_item.issue_id = issue.id and issue_item.included
      ) as no_content
    from issue where status = 'draft'
  `;
  const draft = drafts[0];
  if (!draft) return { outcome: "no-draft" };
  return {
    outcome: "refused",
    number: draft.number,
    missing: [
      ...(draft.no_title ? (["title"] as const) : []),
      ...(draft.no_content ? (["content"] as const) : []),
    ],
  };
};

/** A published issue's identity, enough to decide whether anyone is owed it. */
export interface PublishedIssueRef {
  id: string;
  number: number;
}

/** Every published issue, oldest first, so a backlog is sent in the order it was written. */
export const listPublishedIssues = async (sql: Sql): Promise<PublishedIssueRef[]> =>
  sql<PublishedIssueRef[]>`select id, number from issue where status = 'published' order by number`;

/** One issue with its items, whatever its status, or null when it does not exist. */
export const getIssue = async (sql: Sql, id: string): Promise<IssueView | null> => {
  const issues = await sql<IssueRow[]>`
    select id, number, title, intro, status, window_start, window_end
    from issue where id = ${id}
  `;
  return issues[0] ? issueView(sql, issues[0]) : null;
};

export interface PendingIssueDelivery {
  subscriberId: string;
  email: string;
  unsubscribeToken: string;
}

/**
 * Subscribers a published issue still owes a send on a channel. Like the
 * daily digest, a failed attempt leaves the subscriber pending until
 * `MAX_FAILED_DELIVERIES` failures. Unlike the digest there is no taxonomy or
 * significance filter: an issue is one artifact for everyone. Someone who
 * confirmed after the issue was published is not owed it, because it was never
 * addressed to them and would arrive as old news.
 */
export const subscribersAwaitingIssue = async (
  sql: Sql,
  issueId: string,
  channelId: string,
): Promise<PendingIssueDelivery[]> => {
  const rows = await sql<{ id: string; email: string; unsubscribe_token: string }[]>`
    select s.id, s.email, s.unsubscribe_token
    from issue i
    join subscriber s
      on s.confirmed_at is not null
     and s.unsubscribed_at is null
     and s.confirmed_at <= i.published_at
    where i.id = ${issueId}
      and i.status = 'published'
      and not exists (
        select 1 from issue_delivery d
        where d.issue_id = i.id and d.subscriber_id = s.id
          and d.channel = ${channelId} and d.status = 'sent'
      )
      and (
        select count(*) from issue_delivery d
        where d.issue_id = i.id and d.subscriber_id = s.id
          and d.channel = ${channelId} and d.status = 'failed'
      ) < ${MAX_FAILED_DELIVERIES}
    order by s.confirmed_at, s.id
  `;
  return rows.map((row) => ({
    subscriberId: row.id,
    email: row.email,
    unsubscribeToken: row.unsubscribe_token,
  }));
};

/**
 * One `issue_delivery` row per attempt. A second `sent` row for the same issue,
 * subscriber and channel violates `issue_delivery_sent_once_idx` and throws,
 * exactly as `recordDelivery` does for a digest.
 */
export const recordIssueDelivery = async (
  sql: Queryable,
  issueId: string,
  subscriberId: string,
  channelId: string,
  result: DeliveryResult,
): Promise<void> => {
  await sql`
    insert into issue_delivery (issue_id, subscriber_id, channel, status, error)
    values (${issueId}, ${subscriberId}, ${channelId}, ${result.status},
            ${result.status === "failed" ? result.error : null})
  `;
};

/**
 * Curation writes. The rules (draft only, window membership, trimming, caps)
 * live in the SQL functions from migration 10 so the CLI, the tests and the
 * browser share one implementation; these wrappers only call them. Each takes
 * a `Queryable` so a caller can run it inside a transaction.
 */
export const includeEvent = async (
  sql: Queryable,
  issueId: string,
  eventId: string,
): Promise<void> => {
  await sql`select public.issue_include_event(${issueId}::uuid, ${eventId}::uuid)`;
};

export const excludeEvent = async (
  sql: Queryable,
  issueId: string,
  eventId: string,
): Promise<void> => {
  await sql`select public.issue_exclude_event(${issueId}::uuid, ${eventId}::uuid)`;
};

export const annotateItem = async (
  sql: Queryable,
  issueId: string,
  eventId: string,
  note: string | null,
  section: Section,
): Promise<void> => {
  await sql`
    select public.issue_annotate_item(${issueId}::uuid, ${eventId}::uuid, ${note}::text, ${section}::text)
  `;
};

export const setHeading = async (
  sql: Queryable,
  issueId: string,
  title: string,
  intro: string,
): Promise<void> => {
  await sql`select public.issue_set_heading(${issueId}::uuid, ${title}::text, ${intro}::text)`;
};
