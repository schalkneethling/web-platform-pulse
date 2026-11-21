import { expect, test } from "@playwright/test";
import { anonKey, authenticatedToken, REST_URL } from "../scripts/dev-rest.ts";
import { OPERATOR_EMAIL, OPERATOR_USER_ID, STRANGER_USER_ID } from "./accounts.ts";
import { connect } from "../src/store/db.ts";
import { openIssue } from "../src/store/issue.ts";

// Slice G.2 (#68): the curation functions and the operator policies, reached
// through the real local PostgREST with a minted token. The integration tests
// set `request.jwt.claims` by hand; this one proves PostgREST puts the token's
// claims there the way the database expects. The page itself arrives in G.5.
//
// Serial, because the tests share one draft issue and clean it up at the end.
test.describe.configure({ mode: "serial" });

let issueId = "";
let eventId = "";

test.beforeAll(async () => {
  const sql = connect();
  try {
    // The window ends a minute ahead so every event the global setup ingested
    // (stamped with the real clock) falls inside it.
    issueId = (await openIssue(sql, new Date(Date.now() + 60_000))).issueId;
    const [event] = await sql<{ id: string }[]>`
      select event_id as id from issue_item where issue_id = ${issueId} limit 1
    `;
    eventId = event!.id;
  } finally {
    await sql.end();
  }
});

test.afterAll(async () => {
  const sql = connect();
  try {
    await sql`delete from issue where id = ${issueId}`;
  } finally {
    await sql.end();
  }
});

const headers = (token: string) => ({ Authorization: `Bearer ${token}` });

test("the operator's token reads the draft and curates it through PostgREST", async ({
  request,
}) => {
  const operator = headers(authenticatedToken(OPERATOR_USER_ID));

  const issues = await request.get(`${REST_URL}/issue?select=id,status`, { headers: operator });
  expect(issues.ok()).toBe(true);
  expect(await issues.json()).toEqual([{ id: issueId, status: "draft" }]);

  const heading = await request.post(`${REST_URL}/rpc/issue_set_heading`, {
    headers: operator,
    data: { target_issue: issueId, new_title: "Over HTTP", new_intro: "" },
  });
  expect(heading.ok()).toBe(true);

  const note = await request.post(`${REST_URL}/rpc/issue_annotate_item`, {
    headers: operator,
    data: {
      target_issue: issueId,
      target_event: eventId,
      new_note: "  Written through PostgREST ",
      new_section: "watch",
    },
  });
  expect(note.ok()).toBe(true);

  const items = await request.get(
    `${REST_URL}/issue_item?select=note,section,included&event_id=eq.${eventId}`,
    {
      headers: operator,
    },
  );
  expect(await items.json()).toEqual([
    { note: "Written through PostgREST", section: "watch", included: true },
  ]);
});

test("a JSON null argument leaves that field as it is", async ({ request }) => {
  const operator = headers(authenticatedToken(OPERATOR_USER_ID));

  // The previous test left the note "Written through PostgREST" and the title
  // "Over HTTP". Sending null for one of each pair is what the page does for
  // the field it did not change.
  const section = await request.post(`${REST_URL}/rpc/issue_annotate_item`, {
    headers: operator,
    data: { target_issue: issueId, target_event: eventId, new_note: null, new_section: "voices" },
  });
  expect(section.ok()).toBe(true);
  const intro = await request.post(`${REST_URL}/rpc/issue_set_heading`, {
    headers: operator,
    data: { target_issue: issueId, new_title: null, new_intro: "An intro." },
  });
  expect(intro.ok()).toBe(true);

  const items = await request.get(
    `${REST_URL}/issue_item?select=note,section&event_id=eq.${eventId}`,
    { headers: operator },
  );
  expect(await items.json()).toEqual([{ note: "Written through PostgREST", section: "voices" }]);
  const issues = await request.get(`${REST_URL}/issue?select=title,intro`, { headers: operator });
  expect(await issues.json()).toEqual([{ title: "Over HTTP", intro: "An intro." }]);
});

test("a signed-in user who is not the operator sees nothing and cannot write", async ({
  request,
}) => {
  const stranger = headers(authenticatedToken(STRANGER_USER_ID));
  const issues = await request.get(`${REST_URL}/issue`, { headers: stranger });
  expect(await issues.json()).toEqual([]);

  const heading = await request.post(`${REST_URL}/rpc/issue_set_heading`, {
    headers: stranger,
    data: { target_issue: issueId, new_title: "Hijacked", new_intro: "" },
  });
  expect(heading.status()).toBe(403);
});

test("the operator's address under another user's id is refused", async ({ request }) => {
  const impostor = headers(authenticatedToken(STRANGER_USER_ID, OPERATOR_EMAIL));
  const issues = await request.get(`${REST_URL}/issue`, { headers: impostor });
  expect(await issues.json()).toEqual([]);
});

test("the public anon key cannot read the issue tables or call the functions", async ({
  request,
}) => {
  const anon = headers(anonKey());
  expect((await request.get(`${REST_URL}/issue`, { headers: anon })).status()).toBe(401);
  const heading = await request.post(`${REST_URL}/rpc/issue_set_heading`, {
    headers: anon,
    data: { target_issue: issueId, new_title: "Hijacked", new_intro: "" },
  });
  expect(heading.status()).toBe(401);
});
