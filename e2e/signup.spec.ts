import { expect, test } from "@playwright/test";
import { connect } from "../src/store/db.ts";

// Slice F.8 outer test (§17): a visitor subscribes through the real reader,
// real PostgREST and the real request_subscription function, and the row
// lands unconfirmed. The database is read directly because anon cannot read
// `subscriber` -- which is the point.
test("a visitor can sign up and an unconfirmed subscriber is created", async ({ page }) => {
  const email = `visitor-${Date.now()}@example.com`;

  await page.goto("/");

  const section = page.getByRole("region", { name: "Get the digest by email" });
  await section.getByLabel("Email address").fill(email);
  await section.getByRole("button", { name: "Subscribe" }).click();

  const status = section.getByText("Check your inbox to confirm your subscription.");
  await expect(status).toBeVisible();
  // The button was disabled while submitting; focus must land on the outcome.
  await expect(status).toBeFocused();

  const sql = connect();
  try {
    const rows = await sql<{ confirmed_at: Date | null; confirmation_sent_at: Date | null }[]>`
      select confirmed_at, confirmation_sent_at from subscriber where email = ${email}
    `;
    expect(rows).toEqual([{ confirmed_at: null, confirmation_sent_at: null }]);
  } finally {
    await sql.end();
  }
});
