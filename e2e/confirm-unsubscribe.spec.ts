import { expect, test, type Page } from "@playwright/test";
import { connect } from "../src/store/db.ts";

// Slice F.9 outer test (§17): the links in a subscriber's email, through the
// real reader, real PostgREST and the real confirm_subscription and
// unsubscribe functions. The database is read directly because anon cannot
// read `subscriber`.

interface SubscriberState {
  confirm_token: string;
  unsubscribe_token: string;
  confirmed_at: Date | null;
  unsubscribed_at: Date | null;
}

const subscriberState = async (email: string): Promise<SubscriberState> => {
  const sql = connect();
  try {
    const rows = await sql<SubscriberState[]>`
      select confirm_token, unsubscribe_token, confirmed_at, unsubscribed_at
      from subscriber where email = ${email}
    `;
    return rows[0]!;
  } finally {
    await sql.end();
  }
};

const signUp = async (page: Page): Promise<string> => {
  const email = `visitor-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await page.goto("/");
  const section = page.getByRole("region", { name: "Get the digest by email" });
  await section.getByLabel("Email address").fill(email);
  await section.getByRole("button", { name: "Subscribe" }).click();
  await expect(section.getByText("Check your inbox to confirm your subscription.")).toBeVisible();
  return email;
};

test("the confirm link confirms only when the button is pressed", async ({ page }) => {
  const email = await signUp(page);
  const { confirm_token } = await subscriberState(email);

  await page.goto(`/confirm?token=${confirm_token}`);
  const button = page.getByRole("button", { name: "Confirm subscription" });
  await expect(button).toBeVisible();

  // Loading the page is what a mail scanner does. It must not confirm.
  expect((await subscriberState(email)).confirmed_at).toBeNull();

  await button.click();
  const confirmed = page.getByText("You are subscribed.");
  await expect(confirmed).toBeVisible();
  // The button is gone; focus must land on the outcome, not the page body.
  await expect(confirmed).toBeFocused();
  expect((await subscriberState(email)).confirmed_at).not.toBeNull();
});

test("the unsubscribe link unsubscribes only when the button is pressed", async ({ page }) => {
  const email = await signUp(page);
  const { unsubscribe_token } = await subscriberState(email);

  await page.goto(`/unsubscribe?token=${unsubscribe_token}`);
  const button = page.getByRole("button", { name: "Unsubscribe" });
  await expect(button).toBeVisible();

  expect((await subscriberState(email)).unsubscribed_at).toBeNull();

  await button.click();
  const done = page.getByText("You are unsubscribed.");
  await expect(done).toBeVisible();
  await expect(done).toBeFocused();
  expect((await subscriberState(email)).unsubscribed_at).not.toBeNull();
});

test("an unknown token shows the invalid state", async ({ page }) => {
  await page.goto("/confirm?token=00000000-0000-4000-8000-000000000000");
  await page.getByRole("button", { name: "Confirm subscription" }).click();

  const invalid = page.getByText("This link is not valid.");
  await expect(invalid).toBeVisible();
  // The button stays but was disabled mid-request, which drops focus.
  await expect(invalid).toBeFocused();
  await expect(page.getByText("You are subscribed.")).toBeHidden();
});

test("a malformed token shows the invalid state, not an error", async ({ page }) => {
  await page.goto("/unsubscribe?token=not-a-uuid");
  await page.getByRole("button", { name: "Unsubscribe" }).click();

  await expect(page.getByText("This link is not valid.")).toBeVisible();
  await expect(page.getByText("expired")).toHaveCount(0);
});

test("a link without a token says it is incomplete and offers no button", async ({ page }) => {
  await page.goto("/confirm");

  await expect(page.getByText("This link is incomplete")).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Back to the latest digest" })).toHaveAttribute(
    "href",
    "/",
  );
});
