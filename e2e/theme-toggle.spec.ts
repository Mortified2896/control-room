import { expect, test } from "@playwright/test";

test("theme toggle flips light/dark and persists across reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("How can I help you today?")).toBeVisible({ timeout: 15_000 });

  const toggle = page.getByTestId("theme-toggle").first();
  await expect(toggle).toBeVisible();

  const startedDark = await page.evaluate(() =>
    document.documentElement.classList.contains("dark"),
  );

  await toggle.click();
  const afterFirstClick = await page.evaluate(() =>
    document.documentElement.classList.contains("dark"),
  );
  expect(afterFirstClick).toBe(!startedDark);

  await page.reload({ waitUntil: "networkidle" });
  const afterReload = await page.evaluate(() =>
    document.documentElement.classList.contains("dark"),
  );
  expect(afterReload).toBe(afterFirstClick);
});
