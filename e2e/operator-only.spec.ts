import { expect, test } from "@playwright/test";

// Slice F.11 (#65): global setup also cuts a digest for a second confirmed
// subscriber, with a window_end later than the operator's and a single item.
// The reader must still render the operator's digest, which holds far more
// than that one item, because the digest policy admits only the operator.
test("the reader shows the operator's digest even when another subscriber's digest is newer", async ({
  page,
}) => {
  await page.goto("/");

  const digest = page.getByRole("article");
  await expect(digest).toBeVisible();
  await expect(digest.locator(".digest-item", { hasText: "Style queries" })).toBeVisible();
  await expect(digest.locator(".digest-item", { hasText: "lh" })).toBeVisible();
  await expect(digest.locator(".digest__theme", { hasText: "JavaScript" })).toBeVisible();
});
