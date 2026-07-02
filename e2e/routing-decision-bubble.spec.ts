/**
 * E2E test for routing decision bubble appearing live in the chat UI.
 *
 * Verifies that when a user sends a message (manual send, Recommend OFF),
 * the routing decision bubble appears live in the assistant message —
 * i.e. it should be visible immediately after the response streams in,
 * not only after a hard reload.
 */

import { expect, test } from "@playwright/test";

test("manual send shows routing decision bubble live", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("How can I help you today?")).toBeVisible({ timeout: 15_000 });

  // Start a real persisted thread.
  const newChatButton = page.getByRole("button", { name: /^New Chat$/i });
  await newChatButton.first().click();
  await page.waitForLoadState("networkidle");

  // Turn OFF Recommend toggle so we exercise the manual-send path.
  const recommendToggle = page.getByTestId("recommender-toggle");
  await expect(recommendToggle).toBeVisible();
  const isOn = await recommendToggle.getAttribute("aria-pressed");
  if (isOn === "true") {
    await recommendToggle.click();
    await page.waitForTimeout(500);
  }
  await expect(recommendToggle).toHaveAttribute("aria-pressed", "false");

  // Type and send.
  const composer = page.locator('textarea[aria-label*="Message input"]');
  await composer.fill("What is 2 + 2?");
  await composer.press("Enter");

  // Wait for the streamed response to settle.
  await page.waitForTimeout(5000);

  // The routing decision bubble should be visible live (not only after reload).
  const routingBubble = page.getByRole("heading", { name: /Routing decision/i });
  await expect(routingBubble).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(/Route: normal chat/i)).toBeVisible();
});

test("routing decision bubble persists after reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("How can I help you today?")).toBeVisible({ timeout: 15_000 });

  // Start a real persisted thread.
  const newChatButton = page.getByRole("button", { name: /^New Chat$/i });
  await newChatButton.first().click();
  await page.waitForLoadState("networkidle");

  // Recommend OFF (manual send).
  const recommendToggle = page.getByTestId("recommender-toggle");
  await expect(recommendToggle).toBeVisible();
  const isOn = await recommendToggle.getAttribute("aria-pressed");
  if (isOn === "true") {
    await recommendToggle.click();
    await page.waitForTimeout(500);
  }

  // Send a message.
  const composer = page.locator('textarea[aria-label*="Message input"]');
  await composer.fill("Hello world");
  await composer.press("Enter");
  await page.waitForTimeout(5000);

  // Confirm the bubble is visible before reload.
  const routingBubble = page.getByRole("heading", { name: /Routing decision/i });
  await expect(routingBubble).toBeVisible({ timeout: 5000 });

  // Reload and verify the bubble is still visible (DB persistence).
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(routingBubble).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/Route: normal chat/i)).toBeVisible();
});
