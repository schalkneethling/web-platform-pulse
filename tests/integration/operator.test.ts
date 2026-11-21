// Slice F.11 (#65): the operator is an explicit identity (subscriber.is_operator,
// migration 7), not whichever subscriber happens to be first. Real Postgres.
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { connect } from "../../src/store/db.ts";
import { confirmSubscription, ensureOperator, requestSubscription } from "../../src/store/store.ts";

const sql = connect();

const OPERATOR = "operator@example.com";

const signUp = async (email: string): Promise<string> => {
  await requestSubscription(sql, email);
  const [row] = await sql<{ id: string; confirm_token: string }[]>`
    select id, confirm_token from subscriber where email = ${email}
  `;
  await confirmSubscription(sql, row!.confirm_token);
  return row!.id;
};

const operators = () =>
  sql<{ id: string; email: string }[]>`
    select id, email from subscriber where is_operator order by email
  `;

beforeEach(async () => {
  await sql`truncate change_event, event_source, digest, digest_item, source_state, subscription, subscriber restart identity cascade`;
});

afterAll(async () => {
  await sql.end();
});

describe("operator identity", () => {
  it("stays the single operator when a public subscriber is older than the operator", async () => {
    const operatorId = await ensureOperator(sql, OPERATOR);
    await signUp("alice@example.com");
    await signUp("bob@example.com");
    const earlyId = await signUp("early@example.com");
    // Older in every way the "earliest confirmed" heuristic looked at.
    await sql`
      update subscriber
      set created_at = '2000-01-01T00:00:00Z', confirmed_at = '2000-01-01T00:00:00Z'
      where id = ${earlyId}
    `;

    await ensureOperator(sql, OPERATOR);

    expect(await operators()).toEqual([{ id: operatorId, email: OPERATOR }]);
  });

  it("is idempotent", async () => {
    const first = await ensureOperator(sql, OPERATOR);
    const second = await ensureOperator(sql, OPERATOR);
    expect(second).toBe(first);
    expect(await operators()).toEqual([{ id: first, email: OPERATOR }]);
    expect(await sql`select count(*)::int as n from subscription`).toMatchObject([{ n: 1 }]);
  });

  it("heals a row whose flag was cleared", async () => {
    const id = await ensureOperator(sql, OPERATOR);
    await sql`update subscriber set is_operator = false where id = ${id}`;
    expect(await operators()).toEqual([]);

    await ensureOperator(sql, OPERATOR);

    expect(await operators()).toEqual([{ id, email: OPERATOR }]);
  });

  it("treats a case variant of the address as the same subscriber", async () => {
    const id = await ensureOperator(sql, OPERATOR);
    expect(await ensureOperator(sql, "Operator@Example.COM")).toBe(id);
    expect(await sql`select count(*)::int as n from subscriber`).toMatchObject([{ n: 1 }]);
    expect(await operators()).toEqual([{ id, email: OPERATOR }]);
  });

  it("moves the flag when the configured address changes, keeping the old row", async () => {
    const oldId = await ensureOperator(sql, OPERATOR);
    const newId = await ensureOperator(sql, "new-operator@example.com");

    expect(newId).not.toBe(oldId);
    expect(await operators()).toEqual([{ id: newId, email: "new-operator@example.com" }]);
    expect(await sql`select is_operator from subscriber where id = ${oldId}`).toMatchObject([
      { is_operator: false },
    ]);
  });

  it("does not clear unsubscribed_at or unconfirm anyone", async () => {
    const id = await ensureOperator(sql, OPERATOR);
    await sql`update subscriber set unsubscribed_at = now() where id = ${id}`;
    await ensureOperator(sql, OPERATOR);
    expect(
      await sql`select unsubscribed_at, confirmed_at from subscriber where id = ${id}`,
    ).toMatchObject([{ unsubscribed_at: expect.any(Date), confirmed_at: expect.any(Date) }]);
  });

  it("is refused a second operator by the database", async () => {
    await ensureOperator(sql, OPERATOR);
    const otherId = await signUp("alice@example.com");
    await expect(
      sql`update subscriber set is_operator = true where id = ${otherId}`,
    ).rejects.toThrow(/subscriber_one_operator_idx/);
  });
});
