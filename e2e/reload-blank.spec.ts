import { expect, test } from "@playwright/test";

/**
 * Diagnostic Playwright spec for the "white blank page after reload" bug.
 * Walks the exact user-reported path: send a prompt, click a feedback
 * button, reload the page, and capture screenshots at each step.
 */
test("reload does not produce a white blank page", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    pageErrors.push(String(err));
  });

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  // Give the dev server a fair chance — Turbopack first-load can be slow.
  await page.waitForTimeout(2000);

  // The page must not be blank — the composer (the most reliable chat-side
  // element) must be visible after the initial JS hydrates.
  await expect(page.locator('textarea[aria-label*="Message input"]')).toBeVisible({
    timeout: 30_000,
  });
  // Either the empty-state welcome ("How can I help you today?") or the
  // most recent thread's title should be visible.
  const welcomeOrThread = await Promise.race([
    page
      .getByText("How can I help you today?")
      .waitFor({ state: "visible", timeout: 2_000 })
      .then(() => true)
      .catch(() => false),
    page
      .locator(
        '[data-slot="aui_assistant-message-content"], [data-slot="aui_thread-welcome-message-inner"]',
      )
      .first()
      .waitFor({ state: "visible", timeout: 2_000 })
      .then(() => true)
      .catch(() => false),
  ]);
  expect(
    welcomeOrThread,
    "page should not be blank — neither welcome nor chat content visible",
  ).toBe(true);

  // Create a new chat to get a real persisted thread.
  await page
    .getByRole("button", { name: /^New Chat$/i })
    .first()
    .click();
  await page.waitForLoadState("networkidle");

  // Send a prompt and wait for the panel.
  await page.locator('textarea[aria-label*="Message input"]').fill("What is 2 + 2?");
  await page.locator('textarea[aria-label*="Message input"]').press("Enter");
  await expect(page.getByTestId("router-ab-panel").first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: "test-results/reload-before.png", fullPage: true });

  // Click Prefer A and confirm it's persisted.
  const preferAButton = page.getByTestId("router-ab-feedback-prefer-a").first();
  await preferAButton.click();
  await expect(preferAButton).toHaveAttribute("aria-pressed", "true", { timeout: 5_000 });

  // Reload.
  consoleErrors.length = 0;
  pageErrors.length = 0;
  await page.reload();

  // Wait up to 20 seconds for the page to render something meaningful.
  // If we see "How can I help you today?" again that means we got the empty
  // new-chat state — which means the thread isn't rehydrating. If we see the
  // panel rehydrated with feedback "true" pressed, success.
  await page.waitForLoadState("domcontentloaded");
  await page.screenshot({ path: "test-results/reload-just-after.png", fullPage: true });

  // The chat composer should be visible (which means the page is not blank).
  await expect(page.locator('textarea[aria-label*="Message input"]')).toBeVisible({
    timeout: 20_000,
  });

  // Wait for either the new-chat welcome or the panel to appear.
  const panelVisible = await page
    .getByTestId("router-ab-panel")
    .first()
    .isVisible()
    .catch(() => false);
  const welcomeVisible = await page
    .getByText("How can I help you today?")
    .isVisible()
    .catch(() => false);

  console.log(
    JSON.stringify({
      panelVisible,
      welcomeVisible,
      consoleErrors,
      pageErrors,
    }),
  );

  await page.screenshot({ path: "test-results/reload-after.png", fullPage: true });

  // If panel is visible, the feedback must still be pressed (re-hydrated).
  if (panelVisible) {
    await expect(page.getByTestId("router-ab-feedback-prefer-a").first()).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: 10_000 },
    );
  } else {
    throw new Error(
      `No panel visible after reload. consoleErrors=${JSON.stringify(consoleErrors)} pageErrors=${JSON.stringify(pageErrors)}`,
    );
  }
});
