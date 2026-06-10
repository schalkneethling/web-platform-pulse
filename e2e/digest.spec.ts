import { expect, test } from "@playwright/test";

// Slice 1 outer test (§16): a known Baseline transition appears in a
// rendered digest with a working provenance link. The fixture pair in
// tests/fixtures/web-features records `lh` reaching Baseline widely
// available on 2026-05-21; global setup seeds the database by running
// the real pipeline over those fixtures.
test("a Baseline transition appears in the rendered digest with a provenance link", async ({
  page,
}) => {
  await page.goto("/");

  const digest = page.getByRole("article");
  await expect(digest).toBeVisible();

  const item = digest.locator(".digest-item", { hasText: "lh" });
  await expect(item).toBeVisible();
  await expect(item).toContainText(/widely available/i);

  const provenance = item.getByRole("link", { name: /webstatus\.dev/i });
  await expect(provenance).toHaveAttribute("href", "https://webstatus.dev/features/lh");
});

test("the newly-available transition is also present", async ({ page }) => {
  await page.goto("/");

  const item = page.getByRole("article").locator(".digest-item", { hasText: "Style queries" });
  await expect(item).toContainText(/newly available/i);
});
