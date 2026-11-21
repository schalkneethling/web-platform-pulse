import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vite-plus/test";
import type { ChangeEventRow } from "./digest-source.ts";
import {
  excludeEvent,
  fetchCuration,
  includeEvent,
  saveHeading,
  saveNote,
  toCurationDraft,
  type IssueRow,
} from "./issue-source.ts";

const eventRow = (id: string, overrides: Record<string, unknown> = {}): ChangeEventRow =>
  ({
    id,
    type: "baseline-change",
    subject: { kind: "feature", id },
    title: `Title ${id}`,
    before: null,
    after: null,
    occurred_at: null,
    first_observed_at: "2026-06-10T12:00:00+00:00",
    last_updated_at: "2026-06-10T12:00:00+00:00",
    significance: 0.5,
    taxonomy: ["css"],
    dedupe_key: `k:${id}`,
    correlation_key: `c:${id}`,
    event_source: [
      {
        source_id: "web-features",
        url: `https://example.com/${id}`,
        title: id,
        observed_at: "2026-06-10T12:00:00+00:00",
        raw_ref: null,
      },
    ],
    ...overrides,
  }) as ChangeEventRow;

const issueRow = (overrides: Partial<IssueRow> = {}): IssueRow => ({
  id: "i1",
  number: 3,
  title: "Anchors",
  intro: "Hello",
  window_start: "2026-06-03T00:00:00+00:00",
  window_end: "2026-06-10T00:00:00+00:00",
  issue_item: [],
  ...overrides,
});

describe("toCurationDraft", () => {
  it("lists included events first, then the rest in digest order", () => {
    const draft = toCurationDraft(
      issueRow({
        issue_item: [
          { event_id: "low", position: 1, section: "watch", note: "Because.", included: true },
          { event_id: "off", position: 2, section: "watch", note: "Kept.", included: false },
        ],
      }),
      [
        eventRow("low", { significance: 0.1 }),
        eventRow("high", { significance: 0.9 }),
        eventRow("mid", { significance: 0.5 }),
        eventRow("off", { significance: 0.7 }),
      ],
    );

    // `low` is included, so it leads even though it ranks last. The others
    // follow the order orderForDigest gives a digest: by significance within a theme.
    expect(draft.events.map((e) => e.event.id)).toEqual(["low", "high", "off", "mid"]);
  });

  it("carries the saved state of an item and defaults for an event with no row", () => {
    const draft = toCurationDraft(
      issueRow({
        issue_item: [
          { event_id: "a", position: 1, section: "voices", note: "A note", included: true },
          { event_id: "b", position: 2, section: "watch", note: null, included: false },
        ],
      }),
      [
        eventRow("a", { type: "editorial" }),
        eventRow("b"),
        eventRow("c", { type: "spec-change" }),
        eventRow("d", { type: "baseline-change" }),
      ],
    );
    const byId = Object.fromEntries(draft.events.map((e) => [e.event.id, e]));

    expect(byId.a).toMatchObject({
      hasRow: true,
      included: true,
      section: "voices",
      note: "A note",
    });
    // A null note becomes an empty string: the form edits text, not null.
    expect(byId.b).toMatchObject({ hasRow: true, included: false, section: "watch", note: "" });
    // No row yet: not included, with the section the database would assign on include.
    expect(byId.c).toMatchObject({ hasRow: false, included: false, section: "watch", note: "" });
    expect(byId.d).toMatchObject({ hasRow: false, included: false, section: "shipped" });
  });

  it("normalises the window to UTC instants", () => {
    const draft = toCurationDraft(issueRow(), []);
    expect(draft).toMatchObject({
      id: "i1",
      number: 3,
      title: "Anchors",
      intro: "Hello",
      windowStart: "2026-06-03T00:00:00.000Z",
      windowEnd: "2026-06-10T00:00:00.000Z",
      events: [],
    });
  });
});

interface Call {
  table: string;
  steps: [string, unknown[]][];
}

interface FakeOptions {
  session?: boolean;
  operator?: boolean | { message: string };
  issue?: IssueRow | null;
  issueError?: { message: string };
  events?: ChangeEventRow[];
  eventPages?: ChangeEventRow[][];
  rpcError?: { code: string; message: string } | "throw";
}

/** A chain that records every step and resolves to whatever the table's data is. */
const chain = (call: Call, result: () => unknown) => {
  const builder: Record<string, unknown> = {};
  for (const name of ["select", "eq", "gte", "lt", "order", "range"]) {
    builder[name] = (...args: unknown[]) => {
      call.steps.push([name, args]);
      return builder;
    };
  }
  builder.maybeSingle = () => {
    call.steps.push(["maybeSingle", []]);
    return Promise.resolve(result());
  };
  // overrideTypes is the last call of the events query, so it settles the chain.
  builder.overrideTypes = () => {
    call.steps.push(["overrideTypes", []]);
    return Promise.resolve(result());
  };
  return builder;
};

const fakeClient = (options: FakeOptions = {}) => {
  const calls: Call[] = [];
  const rpcs: { name: string; args: unknown }[] = [];
  let page = 0;
  const client = {
    auth: {
      getSession: () =>
        Promise.resolve({
          data: {
            session:
              options.session === false
                ? null
                : { access_token: "t", user: { id: "user-1", email: "someone@example.com" } },
          },
        }),
    },
    from: (table: string) => {
      const call: Call = { table, steps: [] };
      calls.push(call);
      return chain(call, () => {
        if (table === "issue") {
          return { data: options.issue ?? null, error: options.issueError ?? null };
        }
        if (options.eventPages) return { data: options.eventPages[page++] ?? [], error: null };
        return { data: options.events ?? [], error: null };
      });
    },
    rpc: (name: string, args: unknown) => {
      rpcs.push({ name, args });
      if (options.rpcError === "throw") return Promise.reject(new Error("offline"));
      if (name === "is_operator_request") {
        const operator = options.operator ?? true;
        return Promise.resolve(
          typeof operator === "object"
            ? { data: null, error: operator }
            : { data: operator, error: null },
        );
      }
      return Promise.resolve({ data: null, error: options.rpcError ?? null });
    },
  };
  return { client: client as unknown as SupabaseClient, calls, rpcs };
};

describe("fetchCuration", () => {
  it("reports signed out without asking the database anything", async () => {
    const { client, calls, rpcs } = fakeClient({ session: false });
    expect(await fetchCuration(client)).toEqual({ status: "signed-out" });
    expect(calls).toEqual([]);
    expect(rpcs).toEqual([]);
  });

  it("asks the database whether the account is the operator, and reads nothing for a stranger", async () => {
    const { client, calls, rpcs } = fakeClient({ operator: false, issue: issueRow() });
    // The state carries the account's id so the page can show it, and nothing
    // else about the account: not the address the session also holds.
    expect(await fetchCuration(client)).toEqual({ status: "not-operator", userId: "user-1" });
    expect(rpcs).toEqual([{ name: "is_operator_request", args: undefined }]);
    expect(calls).toEqual([]);
  });

  it("surfaces an error from the operator check instead of guessing", async () => {
    const { client } = fakeClient({ operator: { message: "boom" } });
    await expect(fetchCuration(client)).rejects.toThrow(/boom/);
  });

  it("reports no draft for the operator when none is open, without reading events", async () => {
    const { client, calls } = fakeClient({ issue: null });
    expect(await fetchCuration(client)).toEqual({ status: "no-draft" });
    expect(calls.map((c) => c.table)).toEqual(["issue"]);
  });

  it("reads the draft with its items, then the window's events with provenance", async () => {
    const { client, calls } = fakeClient({
      issue: issueRow(),
      events: [eventRow("e1"), eventRow("e2")],
    });
    const state = await fetchCuration(client);

    expect(state.status).toBe("draft");
    if (state.status !== "draft") return;
    expect(state.draft.events).toHaveLength(2);

    const [issueCall, eventCall] = calls;
    expect(issueCall!.table).toBe("issue");
    expect(issueCall!.steps).toContainEqual(["eq", ["status", "draft"]]);
    expect(issueCall!.steps[0]![1][0]).toContain("issue_item");

    // The same half-open window `issue open` selects from and the include
    // function enforces: start inclusive, end exclusive.
    expect(eventCall!.table).toBe("change_event");
    expect(eventCall!.steps).toContainEqual([
      "gte",
      ["first_observed_at", "2026-06-03T00:00:00+00:00"],
    ]);
    expect(eventCall!.steps).toContainEqual([
      "lt",
      ["first_observed_at", "2026-06-10T00:00:00+00:00"],
    ]);
    expect(eventCall!.steps[0]![1][0]).toContain("event_source");
  });

  it("pages through a window larger than one response", async () => {
    const full = Array.from({ length: 1000 }, (_, index) => eventRow(`a${index}`));
    const { client, calls } = fakeClient({
      issue: issueRow(),
      eventPages: [full, [eventRow("last")]],
    });
    const state = await fetchCuration(client);

    expect(state.status === "draft" && state.draft.events).toHaveLength(1001);
    const ranges = calls
      .filter((c) => c.table === "change_event")
      .map((c) => c.steps.find(([name]) => name === "range"));
    expect(ranges).toEqual([
      ["range", [0, 999]],
      ["range", [1000, 1999]],
    ]);
  });
});

describe("curation writes", () => {
  it("includes and excludes through the migration 10 functions", async () => {
    const { client, rpcs } = fakeClient();
    expect(await includeEvent(client, "i1", "e1")).toEqual({ ok: true });
    expect(await excludeEvent(client, "i1", "e1")).toEqual({ ok: true });
    expect(rpcs).toEqual([
      { name: "issue_include_event", args: { target_issue: "i1", target_event: "e1" } },
      { name: "issue_exclude_event", args: { target_issue: "i1", target_event: "e1" } },
    ]);
  });

  it("saves a note with its section, and a heading with both fields", async () => {
    const { client, rpcs } = fakeClient();
    await saveNote(client, "i1", "e1", "Why it matters", "lead");
    await saveHeading(client, "i1", "Title", "Intro");
    expect(rpcs).toEqual([
      {
        name: "issue_annotate_item",
        args: {
          target_issue: "i1",
          target_event: "e1",
          new_note: "Why it matters",
          new_section: "lead",
        },
      },
      {
        name: "issue_set_heading",
        args: { target_issue: "i1", new_title: "Title", new_intro: "Intro" },
      },
    ]);
  });

  it("tells a permission failure (42501) from any other failure", async () => {
    const denied = fakeClient({ rpcError: { code: "42501", message: "only the operator" } });
    expect(await includeEvent(denied.client, "i1", "e1")).toEqual({
      ok: false,
      reason: "not-operator",
      message: "only the operator",
    });

    const other = fakeClient({ rpcError: { code: "55000", message: "issue 3 is published" } });
    expect(await saveHeading(other.client, "i1", "t", "i")).toEqual({
      ok: false,
      reason: "failed",
      message: "issue 3 is published",
    });
  });

  it("turns a thrown network failure into a failed result", async () => {
    const { client } = fakeClient({ rpcError: "throw" });
    expect(await excludeEvent(client, "i1", "e1")).toEqual({
      ok: false,
      reason: "failed",
      message: "The request could not be sent. Check your connection.",
    });
  });
});
