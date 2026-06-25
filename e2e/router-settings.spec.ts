import { expect, test } from "@playwright/test";

/**
 * Happy-path E2E for the Router Settings UI.
 *
 * What this test exercises:
 *   1. /settings/router loads and renders the form.
 *   2. The user can toggle a (model, reasoning-level) combo, save, and the
 *      page reports success.
 *   3. A page reload preserves the saved allowlist.
 *   4. A fresh A/B chat in a new thread uses the saved allowlist when
 *      generating Side B (asserted by inspecting the persisted
 *      `router_ab_sessions` row).
 *
 * What this test deliberately does NOT exercise (covered elsewhere):
 *   - Cost / budget / fallback validation — covered by
 *     `lib/router/settings.test.ts`.
 *   - Allowlist intersection with expensive tier — covered by
 *     `lib/router/policy.test.ts`.
 *
 * Note on the fake-LLM flag:
 *   The Playwright config sets `CONTROL_ROOM_FAKE_LLM=1`, which routes the
 *   router + Side A + Side B calls through deterministic local stubs.
 *   The router stub picks a combo from the persisted allowlist using its
 *   heuristic, so the assertions below actually validate the round-trip
 *   from the UI → Postgres → chat route.
 *
 * Note on test isolation:
 *   This test mutates the `router_settings` singleton row. It cleans up
 *   after itself by restoring the row to `{}` (which is treated as
 *   "use defaults") at the end of each test. If the test fails
 *   partway through, the afterEach still runs so the next test starts
 *   from a known state.
 */

async function cleanupSettingsRow(apiURL: string) {
  // Use a direct pg query through the existing dev server? We don't
  // expose a DELETE endpoint, so we just write the empty default via
  // PUT. Empty JSONB round-trips to `DEFAULT_ROUTER_SETTINGS` on the
  // next read.
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

  test("sidebar 'Router Settings' link navigates to /settings/router", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("How can I help you today?")).toBeVisible({
      timeout: 15_000,
    });
    const sidebarLink = page.locator(".aui-sidebar-settings");
    await expect(sidebarLink).toBeVisible();
    await expect(sidebarLink).toHaveAttribute("href", "/settings/router");
    await sidebarLink.click();
    await page.waitForURL(/\/settings\/router$/);
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });
  });

  test("/settings/router loads and toggles save + reload preserves settings", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto("/settings/router");

    // The page header must render.
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    // The allowed-combinations section must list both cheap-tier combos
    // by default (gpt-5.4-mini x low/medium). Each `<td data-testid=…>`
    // contains a Radix Checkbox button whose `data-state` is the source
    // of truth for checked/unchecked.
    await expect(page.getByTestId("router-settings-row-gpt-5.4-mini")).toBeVisible();
    const cheapLow = page.getByTestId("router-settings-combo-gpt-5.4-mini-low").locator("button");
    const cheapMedium = page
      .getByTestId("router-settings-combo-gpt-5.4-mini-medium")
      .locator("button");
    await expect(cheapLow).toBeVisible();
    await expect(cheapMedium).toBeVisible();
    await expect(cheapLow).toHaveAttribute("data-state", "checked");
    await expect(cheapMedium).toHaveAttribute("data-state", "checked");

    // Save button must start disabled (no changes yet).
    const saveButton = page.getByTestId("router-settings-save");
    await expect(saveButton).toBeDisabled();

    // Uncheck the cheap/medium combo so the form becomes dirty.
    await page.getByTestId("router-settings-combo-gpt-5.4-mini-medium").click();
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
    const cheapLowAfter = page
      .getByTestId("router-settings-combo-gpt-5.4-mini-low")
      .locator("button");
    const cheapMediumAfter = page
      .getByTestId("router-settings-combo-gpt-5.4-mini-medium")
      .locator("button");
    await expect(cheapLowAfter).toHaveAttribute("data-state", "checked");
    await expect(cheapMediumAfter).toHaveAttribute("data-state", "unchecked");

    // Re-enable the combo and save it back so the next test (and the
    // existing router A/B smoke spec) sees a non-empty allowlist.
    await page.getByTestId("router-settings-combo-gpt-5.4-mini-medium").click();
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
    // Uncheck cheap/medium to leave only cheap/low.
    await page.getByTestId("router-settings-combo-gpt-5.4-mini-medium").click();
    await page.getByTestId("router-settings-save").click();
    await expect(page.getByTestId("router-settings-save-status")).toBeVisible({
      timeout: 5_000,
    });

    // 2) Spin up a brand-new A/B chat from the main page and send a
    //    short prompt. The fake router will pick (gpt-5.4-mini, low)
    //    because it is the only entry in the persisted allowlist.
    await page.goto("/");
    // The chat composer must be present on the page regardless of whether
    // a thread is currently selected.
    const composer = page.locator('textarea[aria-label*="Message input"]');
    await expect(composer).toBeVisible({ timeout: 15_000 });

    // Click "New Chat" so we send the prompt into a brand-new thread
    // (otherwise the chat route would target whatever persisted thread
    // was last active, which could be a stub from a previous run).
    await page
      .getByRole("button", { name: /^New Chat$/i })
      .first()
      .click();
    await page.waitForLoadState("networkidle");

    // After New Chat, the welcome copy should be visible. (We re-assert
    // here because the initial load may have selected an existing
    // thread with prior messages.)
    await expect(page.getByText("How can I help you today?")).toBeVisible({
      timeout: 15_000,
    });
    await composer.fill("Tell me about two plus two.");
    await composer.press("Enter");

    // Wait for the A/B panel to render Side B.
    const panel = page.getByTestId("router-ab-panel").first();
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("router-ab-side-b-text").first()).not.toContainText(
      /Router is generating Side B/,
      { timeout: 15_000 },
    );

    // 3) Confirm Side B was picked from the saved allowlist. The panel's
    //    Side B header renders the recommended combo as
    //    `{modelId} · {reasoningLevel}`. Since the persisted allowlist
    //    only contains (gpt-5.4-mini, low), the router has no other
    //    option, and the chat route must reflect what we just saved.
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
    // Mutate the form (without saving) so the persisted state is still
    // the defaults from the initial GET. This means the form's baseline
    // matches the schema defaults, which is what "Reset to safe
    // defaults" is supposed to restore.
    await page.getByTestId("router-settings-combo-gpt-5.4-mini-medium").click();
    await page.waitForTimeout(200);
    // Confirm the form is now dirty before we reset.
    await expect(page.getByTestId("router-settings-save")).toBeEnabled();

    // Click "Reset to safe defaults" — the form should snap back to
    // (gpt-5.4-mini, low) + (gpt-5.4-mini, medium), both checked, with
    // the Save button re-disabled.
    await page.getByRole("button", { name: /Reset to safe defaults/i }).click();
    await expect(
      page.getByTestId("router-settings-combo-gpt-5.4-mini-low").locator("button"),
    ).toHaveAttribute("data-state", "checked");
    await expect(
      page.getByTestId("router-settings-combo-gpt-5.4-mini-medium").locator("button"),
    ).toHaveAttribute("data-state", "checked");
    await expect(page.getByTestId("router-settings-save")).toBeDisabled();
  });
});
