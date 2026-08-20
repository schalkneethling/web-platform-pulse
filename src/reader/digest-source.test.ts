import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vite-plus/test";
import { type DigestRow, fetchLatestDigest, toDigestView } from "./digest-source.ts";

const eventRow = (overrides: Record<string, unknown> = {}) => ({
  id: "e1",
  type: "baseline-change",
  subject: { kind: "feature", id: "lh" },
  title: "lh unit is now Baseline widely available",
  before: { baseline: "low" },
  after: { baseline: "high" },
  occurred_at: "2026-05-21",
  first_observed_at: "2026-06-10T12:00:00+00:00",
  last_updated_at: "2026-06-11T09:30:00+00:00",
  significance: 0.8,
  taxonomy: ["css"],
  dedupe_key: "web-features:baseline:lh:low->high",
  correlation_key: "baseline:lh:high",
  event_source: [
    {
      source_id: "web-features",
      url: "https://webstatus.dev/features/lh",
      title: "lh unit",
      observed_at: "2026-06-10T12:00:00+00:00",
      raw_ref: null,
    },
  ],
  ...overrides,
});

const digestRow = (overrides: Partial<DigestRow> = {}): DigestRow =>
  ({
    id: "d1",
    cadence: "daily",
    window_start: "2026-06-09T00:00:00+00:00",
    window_end: "2026-06-10T00:00:00+00:00",
    digest_item: [{ position: 0, change_event: eventRow() }],
    ...overrides,
  }) as DigestRow;

describe("toDigestView", () => {
  it("shapes a PostgREST row the way the server's digestView does", () => {
    expect(toDigestView(digestRow())).toEqual({
      id: "d1",
      cadence: "daily",
      windowStart: "2026-06-09T00:00:00.000Z",
      windowEnd: "2026-06-10T00:00:00.000Z",
      items: [
        {
          id: "e1",
          type: "baseline-change",
          subject: { kind: "feature", id: "lh" },
          title: "lh unit is now Baseline widely available",
          before: { baseline: "low" },
          after: { baseline: "high" },
          occurredAt: "2026-05-21",
          firstObservedAt: "2026-06-10T12:00:00.000Z",
          lastUpdatedAt: "2026-06-11T09:30:00.000Z",
          significance: 0.8,
          taxonomy: ["css"],
          dedupeKey: "web-features:baseline:lh:low->high",
          correlationKey: "baseline:lh:high",
          provenance: [
            {
              sourceId: "web-features",
              url: "https://webstatus.dev/features/lh",
              title: "lh unit",
              observedAt: "2026-06-10T12:00:00.000Z",
            },
          ],
        },
      ],
    });
  });

  it("orders items by position, not by the order PostgREST returned them", () => {
    const row = digestRow({
      digest_item: [
        { position: 2, change_event: eventRow({ id: "c" }) },
        { position: 0, change_event: eventRow({ id: "a" }) },
        { position: 1, change_event: eventRow({ id: "b" }) },
      ],
    } as Partial<DigestRow>);
    expect(toDigestView(row).items.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("orders provenance by observed_at then url, as the server query does", () => {
    const row = digestRow({
      digest_item: [
        {
          position: 0,
          change_event: eventRow({
            event_source: [
              {
                source_id: "s",
                url: "https://b.example",
                title: "b",
                observed_at: "2026-06-10T12:00:00+00:00",
                raw_ref: null,
              },
              {
                source_id: "s",
                url: "https://a.example",
                title: "a",
                observed_at: "2026-06-10T12:00:00+00:00",
                raw_ref: null,
              },
              {
                source_id: "s",
                url: "https://z.example",
                title: "z",
                observed_at: "2026-06-09T12:00:00+00:00",
                raw_ref: null,
              },
            ],
          }),
        },
      ],
    } as Partial<DigestRow>);
    expect(toDigestView(row).items[0]?.provenance.map((p) => p.url)).toEqual([
      "https://z.example",
      "https://a.example",
      "https://b.example",
    ]);
  });

  it('orders urls by code point, the way `collate "C"` does', () => {
    // An all-lowercase fixture passes under localeCompare too, so it proves
    // nothing. Case and punctuation are exactly where the two disagree:
    // localeCompare puts "apple" before "Zebra", the database does not.
    const url = (u: string) => ({
      source_id: "s",
      url: u,
      title: u,
      observed_at: "2026-06-10T12:00:00+00:00",
      raw_ref: null,
    });
    const row = digestRow({
      digest_item: [
        {
          position: 0,
          change_event: eventRow({
            event_source: [
              url("https://apple.example"),
              url("https://Zebra.example"),
              url("https://_under.example"),
            ],
          }),
        },
      ],
    } as Partial<DigestRow>);
    expect(toDigestView(row).items[0]?.provenance.map((p) => p.url)).toEqual([
      "https://Zebra.example",
      "https://_under.example",
      "https://apple.example",
    ]);
  });

  it("orders timestamps as instants, not as strings", () => {
    // PostgREST renders an offset, and "+02:00" sorts after "+00:00" as text
    // while being the earlier instant.
    const at = (observed: string, u: string) => ({
      source_id: "s",
      url: u,
      title: u,
      observed_at: observed,
      raw_ref: null,
    });
    const row = digestRow({
      digest_item: [
        {
          position: 0,
          change_event: eventRow({
            event_source: [
              at("2026-06-10T11:00:00+00:00", "https://later.example"),
              at("2026-06-10T12:00:00+02:00", "https://earlier.example"),
            ],
          }),
        },
      ],
    } as Partial<DigestRow>);
    expect(toDigestView(row).items[0]?.provenance.map((p) => p.url)).toEqual([
      "https://earlier.example",
      "https://later.example",
    ]);
  });

  it("carries rawRef only when the column is set", () => {
    const withRef = digestRow({
      digest_item: [
        {
          position: 0,
          change_event: eventRow({
            event_source: [
              {
                source_id: "s",
                url: "https://a.example",
                title: "a",
                observed_at: "2026-06-10T12:00:00+00:00",
                raw_ref: "sha:abc",
              },
            ],
          }),
        },
      ],
    } as Partial<DigestRow>);
    expect(toDigestView(withRef).items[0]?.provenance[0]).toMatchObject({ rawRef: "sha:abc" });
    expect(toDigestView(digestRow()).items[0]?.provenance[0]).not.toHaveProperty("rawRef");
  });

  it("drops an item whose event the policies did not return", () => {
    // A row anon cannot read arrives as a null embed rather than a missing
    // item, so the reader would otherwise render a hole.
    const row = digestRow({
      digest_item: [
        { position: 0, change_event: null },
        { position: 1, change_event: eventRow({ id: "visible" }) },
      ],
    } as Partial<DigestRow>);
    expect(toDigestView(row).items.map((item) => item.id)).toEqual(["visible"]);
  });
});

interface RecordedQuery {
  table?: string;
  select?: string;
  orderColumn?: string;
  orderOptions?: { ascending?: boolean };
  limit?: number;
}

/** Stand-in for the one query chain fetchLatestDigest builds, recording what
 * it was asked for. Discarding the arguments would leave the function's whole
 * contract -- the word "latest" -- unasserted. */
const clientReturning = (
  result: { data: DigestRow | null; error: { message: string } | null },
  recorded: RecordedQuery = {},
) =>
  ({
    from: (table: string) => {
      recorded.table = table;
      return {
        select: (select: string) => {
          recorded.select = select;
          return {
            order: (column: string, options: { ascending?: boolean }) => {
              recorded.orderColumn = column;
              recorded.orderOptions = options;
              return {
                limit: (limit: number) => {
                  recorded.limit = limit;
                  return { maybeSingle: () => Promise.resolve(result) };
                },
              };
            },
          };
        },
      };
    },
  }) as unknown as SupabaseClient;

describe("fetchLatestDigest", () => {
  it("returns null when the pipeline has not cut a digest yet", async () => {
    expect(await fetchLatestDigest(clientReturning({ data: null, error: null }))).toBeNull();
  });

  it("surfaces a PostgREST error rather than rendering an empty digest", async () => {
    await expect(
      fetchLatestDigest(clientReturning({ data: null, error: { message: "permission denied" } })),
    ).rejects.toThrow(/permission denied/);
  });

  it("asks for the newest digest, with the embeds the mapper needs", async () => {
    const recorded: RecordedQuery = {};
    await fetchLatestDigest(clientReturning({ data: digestRow(), error: null }, recorded));
    expect(recorded.table).toBe("digest");
    expect(recorded.orderColumn).toBe("window_end");
    expect(recorded.orderOptions).toEqual({ ascending: false });
    expect(recorded.limit).toBe(1);
    // The embed names are resolved by PostgREST, not by TypeScript; the e2e
    // suite is what proves they exist. This only pins that they are asked for.
    expect(recorded.select).toContain("digest_item");
    expect(recorded.select).toContain("change_event");
    expect(recorded.select).toContain("event_source");
  });

  it("maps a returned row through toDigestView", async () => {
    const digest = await fetchLatestDigest(clientReturning({ data: digestRow(), error: null }));
    expect(digest).toMatchObject({ id: "d1", cadence: "daily" });
    expect(digest?.items).toHaveLength(1);
  });
});
