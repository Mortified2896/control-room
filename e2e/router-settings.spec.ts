import { expect, test } from "@playwright/test";

/**
 * Happy-path E2E for the Router Settings UI.
 *
 * The post-split page renders three focused tabs/cards:
 *   A · Manual chat picker          (Manual toggle persists immediately)
 *   B · Recommender engine          (engine model + thinking + status)
 *   C · Recommender candidates      (Allow recommender + per-row options)
 *
 * This spec exercises a single happy-path flow that uses Tab C to
 * toggle a (model, reasoning-level) combo, save, reload, and confirm
 * the persisted A/B allowlist round-trips. Tab C owns the
 * `allowedCombos` payload that the Side B router reads, so the runtime
 * assertion at the end (a fresh A/B chat in a new thread) still holds.
 */

async function cleanupSettingsRow(apiURL: string) {
  try {
    await fetch(`${apiURL}/api/router-settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allowedCombos: [
          { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
          { modelId: "gpt-5.4-mini", reasoningLevel: "medium" },
        ],
        fallbackModelId: "gpt-5.4-mini",
        fallbackReasoningLevel: "low",
      }),
    });
  } catch {
    // Best-effort cleanup — the afterEach must never throw.
  }
}

async function cleanupSelectorPrefs(apiURL: string) {
  try {
    await fetch(`${apiURL}/api/model-selector-prefs`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferences: {} }),
    });
  } catch {
    // Best-effort cleanup.
  }
}

test.describe("Router Settings UI", () => {
  test.afterEach(async () => {
    await cleanupSettingsRow("http://127.0.0.1:3100");
    await cleanupSelectorPrefs("http://127.0.0.1:3100");
  });

  test("sidebar 'Settings' link navigates to the settings index", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("How can I help you today?")).toBeVisible({
      timeout: 15_000,
    });
    const sidebarLink = page.locator(".aui-sidebar-settings");
    await expect(sidebarLink).toBeVisible();
    // The sidebar links to the Settings index page; the Router Settings
    // tab lives below it.
    await expect(sidebarLink).toHaveAttribute("href", "/settings");
    await sidebarLink.click();
    await page.waitForURL(/\/settings$/);
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({
      timeout: 15_000,
    });
  });

  test("/settings/router loads and toggles save + reload preserves candidates", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto("/settings/router");

    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    // Tab C (Recommender candidates) lists per-row reasoning options.
    await expect(page.getByTestId("router-settings-section-recommender-candidates")).toBeVisible();
    await expect(page.getByTestId("registry-recommender-toggle-gpt-5.4-mini")).toBeVisible();
    const cheapLow = page.getByTestId("registry-reasoning-gpt-5.4-mini-low");
    const cheapMedium = page.getByTestId("registry-reasoning-gpt-5.4-mini-medium");
    await expect(cheapLow).toBeVisible();
    await expect(cheapMedium).toBeVisible();
    await expect(cheapLow).toHaveAttribute("data-state", "checked");
    await expect(cheapMedium).toHaveAttribute("data-state", "checked");

    // Save button must start disabled (no changes yet).
    const saveButton = page.getByTestId("router-settings-save");
    await expect(saveButton).toBeDisabled();

    // Uncheck the cheap/medium combo so the form becomes dirty.
    await page.getByTestId("registry-reasoning-gpt-5.4-mini-medium").click();
    await expect(saveButton).toBeEnabled();

    // Save and confirm the success state.
    await saveButton.click();
    await expect(page.getByTestId("router-settings-save-status")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByTestId("router-settings-save-status")).toContainText(/Saved/i);

    // Reload and confirm the cheap/medium combo is still unchecked while
    // cheap/low is still checked. The Radix Checkbox's `data-state`
    // reflects the persisted allowlist.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });
    const cheapLowAfter = page.getByTestId("registry-reasoning-gpt-5.4-mini-low");
    const cheapMediumAfter = page.getByTestId("registry-reasoning-gpt-5.4-mini-medium");
    await expect(cheapLowAfter).toHaveAttribute("data-state", "checked");
    await expect(cheapMediumAfter).toHaveAttribute("data-state", "unchecked");

    // Re-enable the combo and save it back so the next test (and the
    // existing router A/B smoke spec) sees a non-empty allowlist.
    await page.getByTestId("registry-reasoning-gpt-5.4-mini-medium").click();
    await page.getByTestId("router-settings-save").click();
    await expect(page.getByTestId("router-settings-save-status")).toBeVisible({
      timeout: 5_000,
    });

    // Console error sanity check (same policy as router-ab.spec.ts).
    const fatalConsoleErrors = consoleErrors.filter((msg) => {
      const m = msg.toLowerCase();
      return (
        !m.includes("db_not_configured") &&
        !m.includes("404") &&
        !m.includes("failed to load resource")
      );
    });
    expect(
      fatalConsoleErrors,
      `unexpected console errors: ${fatalConsoleErrors.join("\n")}`,
    ).toEqual([]);
  });

  test("router uses saved allowlist in a new A/B chat", async ({ page }) => {
    // 1) Set the persisted allowlist to ONLY (gpt-5.4-mini, low). This
    //    is what the chat route should resolve for the next prompt.
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("registry-reasoning-gpt-5.4-mini-medium").click();
    await page.getByTestId("router-settings-save").click();
    await expect(page.getByTestId("router-settings-save-status")).toBeVisible({
      timeout: 5_000,
    });

    // 2) Spin up a brand-new A/B chat from the main page and send a
    //    short prompt. The fake router will pick (gpt-5.4-mini, low)
    //    because it is the only entry in the persisted allowlist.
    await page.goto("/");
    const composer = page.locator('textarea[aria-label*="Message input"]');
    await expect(composer).toBeVisible({ timeout: 15_000 });

    await page
      .getByRole("button", { name: /^New Chat$/i })
      .first()
      .click();
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("How can I help you today?")).toBeVisible({
      timeout: 15_000,
    });
    await composer.fill("Tell me about two plus two.");
    await composer.press("Enter");

    const panel = page.getByTestId("router-ab-panel").first();
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("router-ab-side-b-text").first()).not.toContainText(
      /Router is generating Side B/,
      { timeout: 15_000 },
    );

    const sideBHeader = page.getByTestId("router-ab-side-b-header").first();
    await expect(sideBHeader).toContainText(/Router recommendation/i);
    await expect(sideBHeader).toContainText(/gpt-5\.4-mini/i);
    await expect(sideBHeader).toContainText(/low/i);
  });

  test("Reset to safe defaults restores the default allowlist", async ({ page }) => {
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });
    // The page-level "Reset to safe defaults" button restores the
    // DEFAULT_ROUTER_SETTINGS payload — which only ships the Codex
    // entry. The per-row gpt-5.4-mini checkboxes must therefore be
    // unchecked after the reset, and the Codex row checked.
    const candidatesSection = page.getByTestId("router-settings-section-recommender-candidates");
    await candidatesSection.getByTestId("registry-reasoning-gpt-5.4-mini-medium").click();
    await page.waitForTimeout(200);
    await expect(page.getByTestId("router-settings-save")).toBeEnabled();

    await page.getByRole("button", { name: /Reset to safe defaults/i }).click();
    await expect(
      candidatesSection.getByTestId("registry-reasoning-codex:gpt-5.4-mini-low"),
    ).toHaveAttribute("data-state", "checked");
    await expect(
      candidatesSection.getByTestId("registry-reasoning-gpt-5.4-mini-medium"),
    ).toHaveAttribute("data-state", "unchecked");
    // After reset, the form MAY still differ from the saved baseline
    // (defaults are not always equal to the saved payload), so we
    // don't assert on Save-button enabled state here. The two checkbox
    // assertions above prove the reset wrote the defaults payload.
  });

  test("Tab C: per-row reasoning checkboxes toggle independently", async ({ page }) => {
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    const lowCheckbox = page.getByTestId("registry-reasoning-gpt-5.4-mini-low");
    const mediumCheckbox = page.getByTestId("registry-reasoning-gpt-5.4-mini-medium");

    // Defaults: both checked.
    await expect(lowCheckbox).toHaveAttribute("data-state", "checked");
    await expect(mediumCheckbox).toHaveAttribute("data-state", "checked");

    // Toggling off "medium" leaves "low" checked.
    await mediumCheckbox.click();
    await expect(lowCheckbox).toHaveAttribute("data-state", "checked");
    await expect(mediumCheckbox).toHaveAttribute("data-state", "unchecked");

    // Re-toggle back on.
    await mediumCheckbox.click();
    await expect(mediumCheckbox).toHaveAttribute("data-state", "checked");
  });

  test("Unconfigured model has its Recommender toggle locked", async ({ page }) => {
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    // The unknown fake model is unconfigured, so the Recommender toggle
    // in Tab C is replaced by a disabled "Disabled" lock chip.
    const locked = page.getByTestId("registry-recommender-locked-gpt-fake-unknown-xyz");
    await expect(locked).toBeVisible();
    await expect(locked).toContainText(/Disabled/i);
  });

  test.describe("Tab B — Recommender engine (two-lane layout)", () => {
    test("renders both recommender lanes with primary and fallback pickers", async ({ page }) => {
      await page.goto("/settings/router");
      await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
        timeout: 15_000,
      });

      // Token threshold must be visible and editable.
      const threshold = page.getByTestId("router-settings-token-threshold");
      await expect(threshold).toBeVisible();

      // Default lane pickers.
      await expect(page.getByTestId("router-settings-default-lane-model")).toBeVisible();
      await expect(page.getByTestId("router-settings-default-lane-reasoning")).toBeVisible();
      await expect(page.getByTestId("router-settings-default-lane-fallback-model")).toBeVisible();
      await expect(page.getByTestId("router-settings-default-lane-fallback-reasoning")).toBeVisible();

      // Long-prompt lane pickers.
      await expect(page.getByTestId("router-settings-long-prompt-lane-model")).toBeVisible();
      await expect(page.getByTestId("router-settings-long-prompt-lane-reasoning")).toBeVisible();
      await expect(page.getByTestId("router-settings-long-prompt-lane-fallback-model")).toBeVisible();
      await expect(page.getByTestId("router-settings-long-prompt-lane-fallback-reasoning")).toBeVisible();
    });

    test("token threshold change makes save button enabled", async ({ page }) => {
      await page.goto("/settings/router");
      await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
        timeout: 15_000,
      });

      const saveButton = page.getByTestId("router-settings-save");
      // Form starts clean.
      await expect(saveButton).toBeDisabled();

      // Focus the token threshold input and change its value.
      const threshold = page.getByTestId("router-settings-token-threshold");
      await threshold.click();
      await threshold.fill("150000");

      // Now save should be enabled.
      await expect(saveButton).toBeEnabled();

      // Reset: set it back to default 120000.
      await threshold.fill("120000");
      await expect(saveButton).toBeDisabled();
    });

    test("switching a lane model enables save button", async ({ page }) => {
      await page.goto("/settings/router");
      await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
        timeout: 15_000,
      });

      const saveButton = page.getByTestId("router-settings-save");
      await expect(saveButton).toBeDisabled();

      // Click the default lane model selector.
      await page.getByTestId("router-settings-default-lane-model").click();

      // Select a different option from the popover.
      const options = page.locator('[role="option"]');
      const count = await options.count();
      expect(count).toBeGreaterThan(1);

      // Select the second option (first is the current default).
      await options.nth(1).click();

      // Save should now be enabled.
      await expect(saveButton).toBeEnabled();

      // Reset by selecting the first option again.
      await page.getByTestId("router-settings-default-lane-model").click();
      await options.first().click();
      await expect(saveButton).toBeDisabled();
    });
  });
});
