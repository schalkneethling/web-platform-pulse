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

// #55 (Slice D.4): the reader folds overflow items behind a native
// <details>/<summary> (#54). The web-features fixture pair now carries six
// JavaScript (tc39.es) baseline transitions against THEME_ITEM_CAP of 5, so
// the "javascript" theme renders one folded unit, while the CSS theme stays
// at its existing 4 units and must show no fold at all.
test("an overflowing theme folds its extra items behind a collapsed details/summary", async ({
  page,
}) => {
  await page.goto("/");

  const jsTheme = page.getByRole("article").locator(".digest__theme", { hasText: "JavaScript" });
  const details = jsTheme.locator("details.digest__overflow");
  await expect(details).toBeAttached();
  await expect(details).not.toHaveAttribute("open");

  const summary = details.getByText(/^\d+ more in JavaScript$/);
  await expect(summary).toBeVisible();
  await expect(summary).toHaveText("1 more in JavaScript");

  // The folded item is not visible until the summary is activated.
  const hiddenItem = details.locator(".digest-item");
  await expect(hiddenItem).not.toBeVisible();

  await summary.click();

  await expect(details).toHaveAttribute("open", "");
  await expect(hiddenItem).toBeVisible();
});

test("the folded summary is keyboard-operable", async ({ page }) => {
  await page.goto("/");

  const jsTheme = page.getByRole("article").locator(".digest__theme", { hasText: "JavaScript" });
  const details = jsTheme.locator("details.digest__overflow");
  const summary = details.getByText(/^\d+ more in JavaScript$/);
  const hiddenItem = details.locator(".digest-item");

  await expect(hiddenItem).not.toBeVisible();

  await summary.focus();
  await page.keyboard.press("Enter");

  await expect(details).toHaveAttribute("open", "");
  await expect(hiddenItem).toBeVisible();
});

test("a theme under the cap renders no overflow fold", async ({ page }) => {
  await page.goto("/");

  const cssTheme = page.getByRole("article").locator(".digest__theme", { hasText: "CSS" });
  await expect(cssTheme).toBeVisible();
  await expect(cssTheme.locator("details.digest__overflow")).toHaveCount(0);
});
