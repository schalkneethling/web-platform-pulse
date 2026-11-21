// `operator link` and `operator unlink`: the commands that tell the database
// which Supabase Auth user is the operator. Real Postgres.
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { runOperatorLink, runOperatorUnlink } from "../../src/cli/operator.ts";
import { connect } from "../../src/store/db.ts";
import { ensureOperator } from "../../src/store/store.ts";

const sql = connect();

const OPERATOR = "operator@example.com";
const USER = "11111111-1111-4111-8111-111111111111";

const linkOfOperator = async (): Promise<string | null> =>
  (
    await sql<
      { auth_user_id: string | null }[]
    >`select auth_user_id from subscriber where is_operator`
  )[0]!.auth_user_id;

const collect = async (run: (write: (line: string) => void) => Promise<boolean>) => {
  const lines: string[] = [];
  const ok = await run((line) => lines.push(line));
  return { ok, lines };
};

beforeEach(async () => {
  await sql`truncate subscription, subscriber restart identity cascade`;
});

afterAll(async () => {
  await sql.end();
});

describe("runOperatorLink", () => {
  it("links the auth user to the operator and says what it did", async () => {
    await ensureOperator(sql, OPERATOR);

    const { ok, lines } = await collect((write) => runOperatorLink(sql, OPERATOR, USER, write));

    expect(ok).toBe(true);
    expect(lines.join("\n")).toContain(USER);
    expect(lines.join("\n")).toMatch(/can now curate/);
    expect(await linkOfOperator()).toBe(USER);
  });

  it("fails, and says to run the pipeline first, when no operator has that address", async () => {
    const { ok, lines } = await collect((write) =>
      runOperatorLink(sql, "nobody@example.com", USER, write),
    );

    expect(ok).toBe(false);
    expect(lines.join("\n")).toMatch(/no operator with that address/i);
    expect(lines.join("\n")).toContain("vp run pulse");
  });
});

describe("runOperatorUnlink", () => {
  it("removes the link", async () => {
    await ensureOperator(sql, OPERATOR);
    await runOperatorLink(sql, OPERATOR, USER, () => {});

    const { ok, lines } = await collect((write) => runOperatorUnlink(sql, OPERATOR, write));

    expect(ok).toBe(true);
    expect(lines.join("\n")).toMatch(/unlinked/i);
    expect(await linkOfOperator()).toBeNull();
  });

  it("succeeds without changing anything when the operator was not linked", async () => {
    await ensureOperator(sql, OPERATOR);

    const { ok, lines } = await collect((write) => runOperatorUnlink(sql, OPERATOR, write));

    expect(ok).toBe(true);
    expect(lines.join("\n")).toMatch(/was not linked/i);
  });

  it("fails when no operator has that address", async () => {
    const { ok } = await collect((write) => runOperatorUnlink(sql, "nobody@example.com", write));
    expect(ok).toBe(false);
  });
});
