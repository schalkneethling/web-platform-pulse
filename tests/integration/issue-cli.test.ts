import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { runIssueOpen } from "../../src/cli/issue.ts";
import { connect } from "../../src/store/db.ts";
import { ensureSource, ingestCandidates } from "../../src/store/store.ts";

const sql = connect();

const collect = async (): Promise<string[]> => {
  const lines: string[] = [];
  await runIssueOpen(sql, (line) => lines.push(line));
  return lines;
};

beforeEach(async () => {
  await sql`truncate issue, issue_item, issue_delivery, change_event, event_source, source_state restart identity cascade`;
  await ensureSource(sql, "web-features", "artifact-diff");
});

afterAll(async () => {
  await sql.end();
});

describe("runIssueOpen", () => {
  it("prints the number, window, pre-filled count and the un-annotated warning", async () => {
    await ingestCandidates(sql, [
      {
        type: "baseline-change",
        subject: { kind: "feature", id: "lh" },
        title: "lh reached Baseline",
        before: null,
        after: { baseline: "high" },
        occurredAt: null,
        taxonomy: ["css"],
        dedupeKey: "test:lh",
        correlationKey: "test:lh",
        provenance: [
          {
            sourceId: "web-features",
            url: "https://example.com/lh",
            title: "lh",
            observedAt: new Date().toISOString(),
          },
        ],
      },
    ]);
    const lines = await collect();
    expect(lines[0]).toBe("issue #1 opened as a draft");
    expect(lines[1]).toMatch(/^window: \d{4}-.+Z to \d{4}-.+Z$/);
    expect(lines[2]).toBe("items: 1 pre-filled");
    expect(lines[3]).toMatch(/^warning: no included item has a note/);
  });

  it("reports an existing draft without changing it, and omits the warning when there are no items", async () => {
    await collect();
    const lines = await collect();
    expect(lines[0]).toBe("issue #1 is already open as a draft; nothing changed");
    expect(lines[2]).toBe("items: 0 included");
    expect(lines).toHaveLength(3);
    expect(await sql`select count(*)::int as n from issue`).toMatchObject([{ n: 1 }]);
  });
});
