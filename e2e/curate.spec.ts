import { expect, test, type Browser, type Page } from "@playwright/test";
import { OPERATOR_EMAIL, OPERATOR_USER_ID, STRANGER_USER_ID } from "./accounts.ts";
import { signInAs } from "./curate-session.ts";
import { MAILPIT_API_URL, MAILPIT_SMTP_URL } from "../scripts/dev-mail.ts";
import { runIssuePreview, runIssuePublish, runIssueRetry } from "../src/cli/issue.ts";
import type { CandidateEvent } from "../src/core/types.ts";
import { createSmtpSender } from "../src/delivery/smtp.ts";
import { connect } from "../src/store/db.ts";
import { openIssue } from "../src/store/issue.ts";
import { confirmSubscription, ingestCandidates, requestSubscription } from "../src/store/store.ts";

// Slice G.5 (#69, #73): the operator's curation page through the real reader,
// real PostgREST and the real migration 10 functions, then the preview and
// publish code paths the commands run.
//
// The weekly issue allows one draft at a time and this file publishes it, so
// the tests run in order in one worker, and playwright.config.ts starts this
// project only after issue-curation-rest.spec.ts has cleaned up its own draft.
test.describe.configure({ mode: "serial" });

const OPERATOR = OPERATOR_EMAIL;
const sql = connect();
const smtp = createSmtpSender(MAILPIT_SMTP_URL);

test.afterAll(async () => {
  await sql.end();
});

// ---------------------------------------------------------------------------
// Sign-in. The reader's Google redirect cannot be followed from a test, so the
// browser is signed in by storing the session supabase-js would have stored
// (see curate-session.ts). The auth server is never contacted for it; the
// "no auth requests" assertions below keep that true.

const signedInPage = async (browser: Browser, userId: string, email?: string) => {
  const context = await browser.newContext();
  const session = await signInAs(context, userId, email);
  const page = await context.newPage();
  const authRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/auth/v1/")) authRequests.push(request.url());
  });
  return { context, page, session, authRequests };
};

const item = (page: Page, title: string) => page.getByRole("group", { name: title });
const savedStatus = (page: Page, title: string) => item(page, title).getByRole("status");

// ---------------------------------------------------------------------------
// Mail catcher helpers.

interface InboxMessage {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

const inbox = async (): Promise<InboxMessage[]> =>
  (
    (await (await fetch(`${MAILPIT_API_URL}/api/v1/messages?limit=200`)).json()) as {
      messages: InboxMessage[];
    }
  ).messages;

const messagesTo = async (address: string): Promise<InboxMessage[]> =>
  (await inbox()).filter((message) => message.To.some((to) => to.Address === address));

const bodyOf = async (message: InboxMessage): Promise<{ text: string; html: string }> => {
  const detail = (await (
    await fetch(`${MAILPIT_API_URL}/api/v1/message/${message.ID}`)
  ).json()) as {
    Text: string;
    HTML: string;
  };
  return { text: detail.Text, html: detail.HTML };
};

// ---------------------------------------------------------------------------
// Seed data. The global setup ingests ten events. These add 120 editorial ones
// in the `voices` theme, which `orderForDigest` ranks last, so the pre-fill (the
// top twelve) is the ten fixture events plus "Extra voice 001" and "002", and
// 118 events are left for the "Show 50 more" button to page through.

const EXTRA_EVENTS = 120;
const extraTitle = (index: number): string => `Extra voice ${String(index).padStart(3, "0")}`;

const extraCandidate = (index: number): CandidateEvent => ({
  type: "editorial",
  subject: { kind: "post", source: "e2e", url: `https://blog.example.com/${index}` },
  title: extraTitle(index),
  before: null,
  after: { title: extraTitle(index) },
  occurredAt: null,
  taxonomy: ["voices"],
  dedupeKey: `e2e:voice:${index}`,
  correlationKey: `e2e:voice:${index}`,
  provenance: [
    {
      sourceId: "web-features",
      url: `https://blog.example.com/${index}`,
      title: extraTitle(index),
      observedAt: new Date().toISOString(),
    },
  ],
});

const LH_TITLE = "lh unit is now Baseline widely available";
const QUERIES_TITLE = "Container style queries is now Baseline newly available";

// ---------------------------------------------------------------------------

test("the operator is told how to open a draft when none is open", async ({ browser }) => {
  const { context, page } = await signedInPage(browser, OPERATOR_USER_ID);
  await page.goto("/curate");

  await expect(page.getByText("There is no draft issue.")).toBeVisible();
  await expect(page.getByText("vp run pulse issue open")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveCount(0);
  await context.close();
});

test.describe("with a draft open", () => {
  test.beforeAll(async () => {
    // The catcher outlives a run; the assertions below count messages.
    await fetch(`${MAILPIT_API_URL}/api/v1/messages`, { method: "DELETE" });
    await ingestCandidates(
      sql,
      Array.from({ length: EXTRA_EVENTS }, (_, index) => extraCandidate(index + 1)),
    );
    // The window ends a minute ahead so every event just ingested, stamped
    // with the real clock, falls inside it.
    await openIssue(sql, new Date(Date.now() + 60_000));
  });

  test("signed out, /curate offers sign-in and shows no issue data", async ({ page }) => {
    await page.goto("/curate");

    await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
    await expect(page.getByText("Issue #1")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveCount(0);
    await expect(page.getByText(extraTitle(1))).toHaveCount(0);
    await expect(page.getByText(LH_TITLE)).toHaveCount(0);
  });

  test("a signed-in account that is not the operator sees no issue data, only its own user id", async ({
    browser,
  }) => {
    const { context, page, authRequests } = await signedInPage(
      browser,
      STRANGER_USER_ID,
      "stranger@example.com",
    );
    await page.goto("/curate");

    await expect(page.getByText("This account is not the operator.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect(page.getByText("Issue #1")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveCount(0);
    await expect(page.getByText(extraTitle(1))).toHaveCount(0);

    // The account's id is shown so the operator can run `operator link` with
    // it. Nothing else about the account is: not the address the session holds.
    await expect(page.getByText(/operator link/)).toBeVisible();
    await expect(page.locator("code", { hasText: STRANGER_USER_ID })).toHaveCount(1);
    await expect(page.getByText("stranger@example.com")).toHaveCount(0);
    expect(authRequests).toEqual([]);
    await context.close();
  });

  test("the operator's address under another account's id is not the operator", async ({
    browser,
  }) => {
    const { context, page } = await signedInPage(browser, STRANGER_USER_ID, OPERATOR);
    await page.goto("/curate");

    await expect(page.getByText("This account is not the operator.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveCount(0);
    await context.close();
  });

  test("the public home page is identical for an operator session and sends the anon key", async ({
    browser,
  }) => {
    const anonymous = await browser.newContext();
    const anonymousPage = await anonymous.newPage();
    await anonymousPage.goto("/");
    const publicText = await anonymousPage.getByRole("article").innerText();

    const { context, page, session, authRequests } = await signedInPage(browser, OPERATOR_USER_ID);
    const restHeaders: Record<string, string>[] = [];
    page.on("request", async (request) => {
      if (request.url().includes("/rest/v1/")) restHeaders.push(await request.allHeaders());
    });
    await page.goto("/");

    // The session has to be there for this test to mean anything.
    expect(await page.evaluate(() => window.localStorage.getItem("pulse-curator-auth"))).not.toBe(
      null,
    );
    await expect(page.getByRole("article")).toBeVisible();
    expect(await page.getByRole("article").innerText()).toBe(publicText);
    await expect(page.getByRole("region", { name: "Get the digest by email" })).toBeVisible();

    expect(restHeaders.length).toBeGreaterThan(0);
    for (const headers of restHeaders) {
      // supabase-js sends the key it is using as both `apikey` and the bearer
      // token. The anon key is minted per process, so compare the two to each
      // other, and rule out the operator's token directly.
      expect(headers.authorization).toBe(`Bearer ${headers.apikey}`);
      expect(headers.authorization).not.toContain(session.accessToken);
    }
    expect(authRequests).toEqual([]);

    await context.close();
    await anonymous.close();
  });

  test("the list shows the first 50 events outside the issue and pages through the rest", async ({
    browser,
  }) => {
    const { context, page } = await signedInPage(browser, OPERATOR_USER_ID);
    await page.goto("/curate");

    // Twelve items are in the issue; 130 events fall in the window.
    await expect(page.getByText("Showing 62 of 130 events from this window.")).toBeVisible();
    await expect(page.getByRole("group", { name: "Extra voice" })).toHaveCount(52);

    await page.getByRole("button", { name: "Show 50 more (68 not shown)" }).click();
    await expect(page.getByText("Showing 112 of 130 events from this window.")).toBeVisible();
    // The press moves focus to the first event it revealed, because the
    // button may disappear and take focus with it.
    await expect(page.locator("input[type=checkbox]:focus")).toHaveCount(1);

    await page.getByRole("button", { name: "Show 18 more (18 not shown)" }).click();
    await expect(page.getByText("Showing 130 of 130 events from this window.")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Show \d+ more/ })).toHaveCount(0);
    await expect(page.locator("input[type=checkbox]:focus")).toHaveCount(1);
    await context.close();
  });

  test("a keyboard alone can include an event, write its note and see it saved", async ({
    browser,
  }) => {
    const title = extraTitle(20);
    const { context, page } = await signedInPage(browser, OPERATOR_USER_ID);
    await page.goto("/curate");

    const row = item(page, title);
    const include = row.getByLabel("Include in the issue");
    await expect(include).not.toBeChecked();

    // Start on the event's link, as a person reading down the list would,
    // then use only Tab, Space and typing.
    await row.getByRole("link").focus();
    await page.keyboard.press("Tab");
    await expect(include).toBeFocused();
    await page.keyboard.press("Space");

    await expect(include).toBeChecked();
    await expect(savedStatus(page, title)).toHaveText("Saved.");
    // Saving did not take focus from the control that was edited.
    await expect(include).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(row.getByLabel("Section")).toBeFocused();
    await page.keyboard.press("Tab");
    const note = row.getByLabel("Note");
    await expect(note).toBeFocused();
    await page.keyboard.type("Typed without a mouse.");
    // Typing alone saves nothing: the note saves on blur.
    const [typed] = await sql<{ note: string | null }[]>`
      select i.note from issue_item i join change_event e on e.id = i.event_id
      where e.title = ${title}
    `;
    expect(typed!.note).toBeNull();
    await page.keyboard.press("Tab");
    await expect(note).not.toBeFocused();
    await expect(savedStatus(page, title)).toHaveText("Saved.");

    const [saved] = await sql<{ note: string; included: boolean }[]>`
      select i.note, i.included from issue_item i join change_event e on e.id = i.event_id
      where e.title = ${title}
    `;
    expect(saved).toEqual({ note: "Typed without a mouse.", included: true });
    await context.close();
  });

  test("a save from a page that is out of date does not overwrite the other field of a pair", async ({
    browser,
  }) => {
    const title = extraTitle(30);
    const context = await browser.newContext();
    await signInAs(context, OPERATOR_USER_ID);
    const fresh = await context.newPage();
    await fresh.goto("/curate");
    await item(fresh, title).getByLabel("Include in the issue").check();
    await expect(savedStatus(fresh, title)).toHaveText("Saved.");

    // The second page loads now, so it holds an empty note, the section the
    // include assigned, and an empty title and intro.
    const stale = await context.newPage();
    await stale.goto("/curate");
    await expect(item(stale, title).getByLabel("Include in the issue")).toBeChecked();

    const row = async () =>
      (
        await sql<{ note: string | null; section: string }[]>`
          select i.note, i.section from issue_item i join change_event e on e.id = i.event_id
          where e.title = ${title}
        `
      )[0]!;

    // The fresh page writes a note. The stale page then changes only the
    // section, and the note must survive.
    await item(fresh, title).getByLabel("Note").fill("Written on the fresh page.");
    await item(fresh, title).getByLabel("Note").blur();
    await expect(savedStatus(fresh, title)).toHaveText("Saved.");
    await item(stale, title).getByLabel("Section").selectOption("watch");
    await expect(savedStatus(stale, title)).toHaveText("Saved.");
    expect(await row()).toEqual({ note: "Written on the fresh page.", section: "watch" });

    // And the other way round: the fresh page's section is out of date now.
    await item(fresh, title).getByLabel("Note").fill("Rewritten on the fresh page.");
    await item(fresh, title).getByLabel("Note").blur();
    await expect(savedStatus(fresh, title)).toHaveText("Saved.");
    expect(await row()).toEqual({ note: "Rewritten on the fresh page.", section: "watch" });

    // The heading pair behaves the same way.
    const heading = async () =>
      (await sql<{ title: string; intro: string }[]>`select title, intro from issue`)[0]!;
    await fresh.getByRole("textbox", { name: "Title", exact: true }).fill("Set on the fresh page");
    await fresh.getByRole("textbox", { name: "Title", exact: true }).blur();
    await expect(fresh.locator("#heading-status")).toHaveText("Saved.");
    await stale.getByRole("textbox", { name: "Intro", exact: true }).fill("Set on the stale page.");
    await stale.getByRole("textbox", { name: "Intro", exact: true }).blur();
    await expect(stale.locator("#heading-status")).toHaveText("Saved.");
    expect(await heading()).toEqual({
      title: "Set on the fresh page",
      intro: "Set on the stale page.",
    });

    await fresh.getByRole("textbox", { name: "Title", exact: true }).fill("Changed again");
    await fresh.getByRole("textbox", { name: "Title", exact: true }).blur();
    await expect(fresh.locator("#heading-status")).toHaveText("Saved.");
    expect(await heading()).toEqual({ title: "Changed again", intro: "Set on the stale page." });
    await context.close();
  });

  test("the operator curates the issue, previews it, publishes it and sees the draft close", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const included = extraTitle(10);
    const note = "This is why anchor positioning matters to you.";
    const { context, page, authRequests } = await signedInPage(browser, OPERATOR_USER_ID);
    await page.goto("/curate");
    await expect(page.getByRole("heading", { name: "Issue #1 (draft)" })).toBeVisible();

    // Title and intro save on blur, only when they changed.
    const title = page.getByRole("textbox", { name: "Title", exact: true });
    const intro = page.getByRole("textbox", { name: "Intro", exact: true });
    const headingStatus = page.locator("#heading-status");
    await title.fill("Anchors, and what else shipped");
    await title.blur();
    await expect(headingStatus).toHaveText("Saved.");
    await intro.fill("A short week.\n\nTwo things are worth your time.");
    await intro.blur();
    await expect(headingStatus).toHaveText("Saved.");

    // Exclude an item the pre-fill chose.
    await item(page, LH_TITLE).getByLabel("Include in the issue").uncheck();
    await expect(savedStatus(page, LH_TITLE)).toHaveText("Saved.");

    // Include one it did not choose; its section comes from its type.
    await expect(item(page, included).getByLabel("Include in the issue")).not.toBeChecked();
    await item(page, included).getByLabel("Include in the issue").check();
    await expect(savedStatus(page, included)).toHaveText("Saved.");
    await expect(item(page, included).getByLabel("Section")).toHaveValue("voices");

    // Change a section.
    await item(page, QUERIES_TITLE).getByLabel("Section").selectOption("watch");
    await expect(savedStatus(page, QUERIES_TITLE)).toHaveText("Saved.");

    // Write a note. Until it is saved the item is flagged as un-annotated.
    await expect(item(page, included).getByText("No note yet")).toBeVisible();
    await item(page, included).getByLabel("Note").fill(note);
    await item(page, included).getByLabel("Note").blur();
    await expect(savedStatus(page, included)).toHaveText("Saved.");
    await expect(item(page, included).getByText("No note yet")).toHaveCount(0);

    const [counts] = await sql<{ included: number; annotated: number }[]>`
      select count(*) filter (where included)::int as included,
             count(*) filter (where included and note is not null)::int as annotated
      from issue_item
    `;
    await expect(
      page.getByText(`${counts!.annotated} of ${counts!.included} included items have a note.`),
    ).toBeVisible();

    // Everything survives a reload, and the included items now come first.
    await page.reload();
    await expect(title).toHaveValue("Anchors, and what else shipped");
    await expect(intro).toHaveValue("A short week.\n\nTwo things are worth your time.");
    await expect(item(page, LH_TITLE).getByLabel("Include in the issue")).not.toBeChecked();
    await expect(item(page, included).getByLabel("Include in the issue")).toBeChecked();
    await expect(item(page, included).getByLabel("Note")).toHaveValue(note);
    await expect(item(page, included).getByLabel("Section")).toHaveValue("voices");
    await expect(item(page, QUERIES_TITLE).getByLabel("Section")).toHaveValue("watch");
    expect(authRequests).toEqual([]);

    // The commands' code paths see the same curation. Preview mails the
    // operator, and mails nothing to subscribers.
    await runIssuePreview(
      sql,
      {
        send: smtp,
        from: "Platform Pulse <pulse@localhost>",
        to: OPERATOR,
        publicUrl: "https://pulse.example.com",
      },
      () => {},
    );
    const previews = (await messagesTo(OPERATOR)).filter((message) =>
      message.Subject.startsWith("[Preview]"),
    );
    expect(previews).toHaveLength(1);
    expect(previews[0]!.Subject).toBe(
      "[Preview] Platform Pulse #1: Anchors, and what else shipped",
    );
    const preview = await bodyOf(previews[0]!);
    for (const body of [preview.text, preview.html]) {
      expect(body).toContain(note);
      expect(body).toContain(included);
      expect(body).not.toContain(LH_TITLE);
    }

    // Publish to a subscriber who confirmed before the issue went out.
    const reader = `reader-${Date.now()}@example.com`;
    await requestSubscription(sql, reader);
    const [subscriber] = await sql<{ confirm_token: string }[]>`
      select confirm_token from subscriber where email = ${reader}
    `;
    await confirmSubscription(sql, subscriber!.confirm_token);

    const lines: string[] = [];
    const publishDeps = {
      send: smtp,
      from: "Platform Pulse <pulse@localhost>",
      publicUrl: "https://pulse.example.com",
    };
    expect(await runIssuePublish(sql, publishDeps, (line) => lines.push(line))).toBe(true);
    expect(lines).toContain("issue #1 published");

    const [issue] = await sql<{ status: string; published_at: Date | null }[]>`
      select status, published_at from issue where number = 1
    `;
    expect(issue!.status).toBe("published");
    expect(issue!.published_at).toBeInstanceOf(Date);

    const published = await messagesTo(reader);
    expect(published).toHaveLength(1);
    expect(published[0]!.Subject).toBe("Platform Pulse #1: Anchors, and what else shipped");
    const email = await bodyOf(published[0]!);
    for (const body of [email.text, email.html]) {
      expect(body).toContain(note);
      expect(body).toContain(included);
      expect(body).not.toContain(LH_TITLE);
    }
    expect(email.text).not.toContain("[Preview]");

    // A retry sends nothing, because everyone already has the issue.
    const sentBefore = (await inbox()).length;
    const secondLines: string[] = [];
    expect(await runIssueRetry(sql, publishDeps, (line) => secondLines.push(line))).toBe(true);
    expect(secondLines.join("\n")).toContain("nothing is waiting to be sent");
    expect(await messagesTo(reader)).toHaveLength(1);
    expect((await inbox()).length).toBe(sentBefore);

    // The page no longer has a draft to edit.
    await page.reload();
    await expect(page.getByText("There is no draft issue.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveCount(0);
    await context.close();
  });
});
