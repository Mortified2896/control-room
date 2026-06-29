import { expect, test } from "@playwright/test";

/**
 * E2E for the model discovery + unified Model Registry UI.
 *
 * Run with the Playwright config (which sets CONTROL_ROOM_FAKE_LLM=1 and
 * CONTROL_ROOM_FAKE_OPENAI_MODELS=1) so the discovery path uses the
 * deterministic fake ids and no real OpenAI call is made.
 *
 * What this test exercises (after the UX refactor):
 *   - Section A (OpenAI Model Discovery) renders the plain-English
 *     summary: discovered / configured / unclassified counts.
 *   - Section B (Model Registry) is the unified table — one row per
 *     discovered model — with the columns: Model, OpenAI, Control Room,
 *     Manual, Router, Reasoning, Tier, Capabilities.
 *   - Section C (Router Global Settings) only contains the global
 *     router knobs (fallback, allow-expensive, threshold). The
 *     per-model router pool table is gone.
 *   - /api/models reflects the manual selector visibility (Manual toggle).
 *   - The router toggle for unconfigured / unclassified models is locked
 *     with a tooltip.
 *   - A new A/B chat uses the persisted allowlist.
 */

const FAKE_FOUR_IDS = ["gpt-5.4-mini", "gpt-5.5", "gpt-fake-known-extra", "gpt-fake-unknown-xyz"];

async function cleanup(apiURL: string) {
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
    /* best effort */
  }
  try {
    await fetch(`${apiURL}/api/model-selector-prefs`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferences: {} }),
    });
  } catch {
    /* best effort */
  }
}

test.describe("Model discovery + unified Model Registry", () => {
  test.afterEach(async () => {
    await cleanup("http://127.0.0.1:3100");
  });

  test("/settings/router loads in fake mode with the unified registry", async ({ page }) => {
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("requestfailed", (req) => {
      failedRequests.push(`${req.method()} ${req.url()} (${req.failure()?.errorText})`);
    });

    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    // Section A: discovery + fake banner + plain-English summary
    await expect(page.getByTestId("router-settings-section-discovery")).toBeVisible();
    await expect(page.getByTestId("discovery-fake-banner")).toBeVisible();
    await expect(page.getByTestId("discovery-summary")).toBeVisible();
    await expect(page.getByTestId("discovery-summary-discovered")).toContainText("4");
    await expect(page.getByTestId("discovery-summary-configured")).toContainText("3");
    await expect(page.getByTestId("discovery-summary-unclassified")).toContainText("1");
    await expect(page.getByTestId("discovery-refresh-button")).toBeVisible();

    // Section B: unified registry table renders all 4 fake ids +
    // sort/filter/search controls.
    await expect(page.getByTestId("router-settings-section-registry")).toBeVisible();
    await expect(page.getByTestId("registry-search")).toBeVisible();
    await expect(page.getByTestId("registry-sort")).toBeVisible();
    await expect(page.getByTestId("registry-filter")).toBeVisible();
    for (const id of FAKE_FOUR_IDS) {
      await expect(page.getByTestId(`registry-row-${id}`)).toBeVisible();
    }
    // The unknown fake is tagged as "unclassified" (renamed from "unknown")
    await expect(
      page.getByTestId("registry-badge-unclassified-gpt-fake-unknown-xyz"),
    ).toBeVisible();
    // The fake badge still applies in fake mode
    await expect(page.getByTestId("registry-badge-fake-gpt-fake-unknown-xyz")).toBeVisible();
    // OpenAI + Control Room columns are separated per row
    await expect(page.getByTestId("registry-provider-pill-gpt-5.4-mini")).toBeVisible();
    await expect(page.getByTestId("registry-controlroom-pill-gpt-5.4-mini")).toBeVisible();
    // Capability placeholders are rendered (disabled)
    await expect(page.getByTestId("registry-capability-gpt-5.4-mini-reasoning")).toBeVisible();
    await expect(page.getByTestId("registry-capability-gpt-5.4-mini-vision")).toBeDisabled();
    await expect(page.getByTestId("registry-capability-gpt-5.4-mini-streaming")).toBeChecked();
    // Tier pill renders for the standard cheap-tier model
    await expect(page.getByTestId("registry-tier-pill-gpt-5.4-mini")).toContainText(/Standard/i);
    await expect(page.getByTestId("registry-tier-pill-gpt-5.5")).toContainText(/Expensive/i);
    // Reasoning column exposes only metadata-supported checkboxes for the configured model.
    await expect(page.getByTestId("registry-reasoning-gpt-5.4-mini-low")).toBeVisible();
    await expect(page.getByTestId("registry-reasoning-gpt-5.4-mini-medium")).toBeVisible();
    await expect(page.getByTestId("registry-reasoning-gpt-5.4-mini-high")).toHaveCount(0);
    // Router toggle renders and is ON by default for a configured + available model
    await expect(page.getByTestId("registry-router-toggle-gpt-5.4-mini")).toHaveAttribute(
      "data-state",
      "checked",
    );
    // Unconfigured model's Router toggle is locked (the brief).
    await expect(page.getByTestId("registry-router-locked-gpt-fake-unknown-xyz")).toBeVisible();

    // Section C: only the global router settings now (fallback + safety knobs).
    // The per-model pool table that used to live here has been folded
    // into the unified registry above.
    await expect(page.getByTestId("router-settings-section-fallback")).toBeVisible();
    await expect(page.getByTestId("router-settings-fallback-model")).toBeVisible();
    await expect(page.getByTestId("router-settings-fallback-reasoning")).toBeVisible();
    await expect(page.getByTestId("router-settings-allow-expensive")).toBeVisible();
    await expect(page.getByTestId("router-settings-allow-long-expensive")).toBeVisible();
    await expect(page.getByTestId("router-settings-threshold")).toBeVisible();

    // Console + network sanity
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

    const benignFailures = failedRequests.filter(
      (req) =>
        !req.includes("/api/chat") &&
        !req.includes("/api/router-ab") &&
        !req.includes("/api/threads") &&
        !req.includes("/api/messages") &&
        !req.includes("/api/db-health") &&
        !req.includes("/api/models"),
    );
    expect(benignFailures, `unexpected failed requests: ${benignFailures.join("\n")}`).toEqual([]);
  });

  test("Refresh button works without OpenAI credentials", async ({ page }) => {
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    const refreshButton = page.getByTestId("discovery-refresh-button");
    await expect(refreshButton).toBeEnabled();
    await refreshButton.click();

    await expect(refreshButton).toBeEnabled({ timeout: 10_000 });
    await expect(page.getByTestId("discovery-error")).toHaveCount(0);
  });

  test("Hiding a configured model removes it from /api/models (manual selector visibility)", async ({
    page,
    request,
  }) => {
    // In fake mode without OPENAI_API_KEY, the chat picker hides
    // OpenAI models by default (manualSelectorVisible defaults to
    // false when usableForChat=false). To exercise the toggle end-to-end,
    // explicitly opt the model in via the prefs API so we start from a
    // known-visible baseline.
    await request.put("/api/model-selector-prefs", {
      data: { preferences: { "gpt-5.4-mini": { visible: true } } },
    });

    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.getByTestId("registry-row-gpt-5.4-mini")).toBeVisible();

    const initial = await request.get("/api/models");
    expect(initial.status()).toBe(200);
    const initialBody = await initial.json();
    const initialIds = (initialBody.models ?? []).map((m: { modelId: string }) => m.modelId);
    expect(initialIds).toContain("gpt-5.4-mini");

    const toggle = page.getByTestId("registry-manual-toggle-gpt-5.4-mini");
    await expect(toggle).toBeVisible();
    // The Manual toggle triggers an async PUT to
    // /api/model-selector-prefs. Wait for the PUT response so the
    // assertion below doesn't race the persistence.
    const putPromise = page.waitForResponse(
      (r) => r.url().endsWith("/api/model-selector-prefs") && r.request().method() === "PUT",
    );
    await toggle.click();
    const putRes = await putPromise;
    expect(putRes.ok()).toBeTruthy();

    const after = await request.get("/api/models");
    expect(after.status()).toBe(200);
    const afterBody = await after.json();
    const afterIds = (afterBody.models ?? []).map((m: { modelId: string }) => m.modelId);
    expect(afterIds).not.toContain("gpt-5.4-mini");

    // The toggled-off model must remain visible in the Settings
    // registry so the user can re-enable it.
    await expect(page.getByTestId("registry-row-gpt-5.4-mini")).toBeVisible();
    // And in the registry DTO returned by /api/router-settings.
    const regR = await request.get("/api/router-settings");
    const regBody = await regR.json();
    const regIds = (regBody.effectiveRegistry?.models ?? []).map(
      (m: { modelId: string }) => m.modelId,
    );
    expect(regIds).toContain("gpt-5.4-mini");

    // Re-enable — model returns to /api/models.
    const reEnablePutPromise = page.waitForResponse(
      (r) => r.url().endsWith("/api/model-selector-prefs") && r.request().method() === "PUT",
    );
    await toggle.click();
    const reEnablePutRes = await reEnablePutPromise;
    expect(reEnablePutRes.ok()).toBeTruthy();
    const restored = await request.get("/api/models");
    const restoredIds = (await restored.json()).models.map((m: { modelId: string }) => m.modelId);
    expect(restoredIds).toContain("gpt-5.4-mini");
  });

  test("Unknown / unclassified fake model cannot enter the router pool via PUT", async ({
    request,
  }) => {
    const res = await request.put("/api/router-settings", {
      data: {
        allowedCombos: [
          { modelId: "gpt-fake-unknown-xyz", reasoningLevel: "low" },
          { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
        ],
        fallbackModelId: "gpt-5.4-mini",
        fallbackReasoningLevel: "low",
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    const errors = (body.errors ?? []) as Array<{ field: string; message: string }>;
    const poolErrors = errors.filter((e) => e.field === "allowedCombos");
    expect(poolErrors.length).toBeGreaterThan(0);
    const combined = poolErrors.map((e) => e.message).join("\n");
    expect(combined).toMatch(
      /not in the local model registry|Unknown model id|cannot enter the router pool/,
    );
  });

  test("Router pool can be changed independently of the manual selector", async ({
    page,
    request,
  }) => {
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.getByTestId("registry-row-gpt-5.4-mini")).toBeVisible();
    await page.getByTestId("registry-manual-toggle-gpt-5.4-mini").click();
    await page.waitForTimeout(500);

    const modelsRes = await request.get("/api/models");
    expect(modelsRes.status()).toBe(200);
    const modelsBody = await modelsRes.json();
    const ids = (modelsBody.models ?? []).map((m: { modelId: string }) => m.modelId);
    expect(ids).not.toContain("gpt-5.4-mini");

    const routerRes = await request.put("/api/router-settings", {
      data: {
        allowedCombos: [
          { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
          { modelId: "gpt-5.4-mini", reasoningLevel: "medium" },
        ],
        fallbackModelId: "gpt-5.4-mini",
        fallbackReasoningLevel: "low",
      },
    });
    expect(routerRes.status()).toBe(200);

    const prefsRes = await request.get("/api/model-selector-prefs");
    const prefsBody = await prefsRes.json();
    expect(prefsBody.preferences?.["gpt-5.4-mini"]?.visible).toBe(false);
  });

  test("Empty router pool is rejected with a clear field-level error", async ({ request }) => {
    const res = await request.put("/api/router-settings", {
      data: {
        allowedCombos: [],
        fallbackModelId: "gpt-5.4-mini",
        fallbackReasoningLevel: "low",
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    const errors = (body.errors ?? []) as Array<{ field: string; message: string }>;
    expect(errors.some((e) => e.field === "allowedCombos")).toBe(true);
  });

  test("Router uses the persisted allowlist in a new A/B chat", async ({ page }) => {
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByTestId("registry-reasoning-gpt-5.4-mini-medium").click();
    await page.getByTestId("router-settings-save").click();
    await expect(page.getByTestId("router-settings-save-status")).toBeVisible({
      timeout: 5_000,
    });

    await page.goto("/");
    await expect(page.getByText("How can I help you today?")).toBeVisible({ timeout: 15_000 });
    const composer = page.locator('textarea[aria-label*="Message input"]');
    await composer.fill("What is 2 + 2?");
    await composer.press("Enter");

    const panel = page.getByTestId("router-ab-panel").first();
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("router-ab-side-b-text").first()).not.toContainText(
      /Router is generating Side B/,
      { timeout: 15_000 },
    );

    const sideBHeader = page.getByTestId("router-ab-side-b-header").first();
    await expect(sideBHeader).toContainText(/gpt-5\.4-mini/i);
    await expect(sideBHeader).toContainText(/low/i);
  });

  test("Registry: sort + filter + search narrow the table", async ({ page }) => {
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    // Search "fake-unknown" should narrow to the one unknown fake
    await page.getByTestId("registry-search").fill("fake-unknown");
    await expect(page.getByTestId("registry-result-count")).toContainText(/Showing 1 of 4/);
    await expect(page.getByTestId("registry-row-gpt-fake-unknown-xyz")).toBeVisible();
    await expect(page.getByTestId("registry-row-gpt-5.4-mini")).toHaveCount(0);

    // Clear search and switch to "Configured only" filter
    await page.getByTestId("registry-search").fill("");
    await page.getByTestId("registry-filter").selectOption("configured");
    await expect(page.getByTestId("registry-result-count")).toContainText(/Showing 3 of 4/);
    await expect(page.getByTestId("registry-row-gpt-fake-unknown-xyz")).toHaveCount(0);

    // Switch to "Not configured" filter
    await page.getByTestId("registry-filter").selectOption("not-configured");
    await expect(page.getByTestId("registry-result-count")).toContainText(/Showing 1 of 4/);
    await expect(page.getByTestId("registry-row-gpt-fake-unknown-xyz")).toBeVisible();
  });

  test("Registry: unconfigured model can be opted in via the Manual toggle", async ({
    page,
    request,
  }) => {
    // Default state: gpt-fake-unknown-xyz is unconfigured + available
    // but hidden from the picker.
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });
    // Filter to not-configured to find it easily.
    await page.getByTestId("registry-filter").selectOption("not-configured");
    const row = page.getByTestId("registry-row-gpt-fake-unknown-xyz");
    await expect(row).toBeVisible();
    // The Control Room column should show "Not configured"
    await expect(page.getByTestId("registry-controlroom-pill-gpt-fake-unknown-xyz")).toContainText(
      /Not configured/,
    );
    // The OpenAI column should show "Available"
    await expect(page.getByTestId("registry-provider-pill-gpt-fake-unknown-xyz")).toContainText(
      /Available/,
    );
    // The Router toggle is locked with the tooltip from the brief.
    const locked = page.getByTestId("registry-router-locked-gpt-fake-unknown-xyz");
    await expect(locked).toBeVisible();
    await expect(locked).toContainText(/Disabled/i);

    // Confirm /api/models does NOT include it before opt-in
    const before = await request.get("/api/models");
    const beforeBody = await before.json();
    const beforeIds = (beforeBody.models ?? []).map((m: { modelId: string }) => m.modelId);
    expect(beforeIds).not.toContain("gpt-fake-unknown-xyz");

    // Opt in via the Manual toggle
    await page.getByTestId("registry-manual-toggle-gpt-fake-unknown-xyz").click();
    await page.waitForTimeout(500);

    // /api/models now includes the opted-in model (even though Control
    // Room has no metadata for it). The chat composer will render it as
    // "enabled: false" because the model id is not in the static
    // registry, but the row is in the picker list — the user can see
    // what they've opted into.
    const after = await request.get("/api/models");
    const afterBody = await after.json();
    const afterEntries = (afterBody.models ?? []) as Array<{
      modelId: string;
      enabled: boolean;
    }>;
    const optedIn = afterEntries.find((m) => m.modelId === "gpt-fake-unknown-xyz");
    expect(optedIn).toBeDefined();
    // The model is listed but not enabled (the chat route will refuse
    // an unconfigured model at runtime).
    expect(optedIn?.enabled).toBe(false);

    // The "override" badge appears in the registry row after opt-in
    await expect(page.getByTestId("registry-badge-overridden-gpt-fake-unknown-xyz")).toBeVisible();

    // Router pool is STILL empty for this model (unconfigured models
    // cannot enter the router pool — that's the safety guarantee).
    const routerRes = await request.put("/api/router-settings", {
      data: {
        allowedCombos: [
          { modelId: "gpt-fake-unknown-xyz", reasoningLevel: "low" },
          { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
        ],
        fallbackModelId: "gpt-5.4-mini",
        fallbackReasoningLevel: "low",
      },
    });
    expect(routerRes.status()).toBe(400);
  });

  test("Registry: Router toggle per row turns all supported reasoning levels on / off", async ({
    page,
  }) => {
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    // Default state: gpt-5.5 has all three reasoning levels enabled
    // (low/medium/high). gpt-5.5 is the expensive-tier model so the
    // "Allow expensive models" switch (Section C) must be ON for it to
    // be in the persisted allowlist. The Router toggle reflects the
    // *persisted* allowlist state, which is whatever was last saved.
    // We assert: the toggle is consistent with the per-level checks.
    const routerToggle = page.getByTestId("registry-router-toggle-gpt-5.4-mini");
    const lowCheckbox = page.getByTestId("registry-reasoning-gpt-5.4-mini-low");
    const mediumCheckbox = page.getByTestId("registry-reasoning-gpt-5.4-mini-medium");
    await expect(routerToggle).toHaveAttribute("data-state", "checked");
    await expect(lowCheckbox).toHaveAttribute("data-state", "checked");
    await expect(mediumCheckbox).toHaveAttribute("data-state", "checked");

    // Click the Router toggle → all reasoning levels for this model
    // become unchecked in one click.
    await routerToggle.click();
    await expect(routerToggle).toHaveAttribute("data-state", "unchecked");
    await expect(lowCheckbox).toHaveAttribute("data-state", "unchecked");
    await expect(mediumCheckbox).toHaveAttribute("data-state", "unchecked");

    // Click again → all re-checked.
    await routerToggle.click();
    await expect(routerToggle).toHaveAttribute("data-state", "checked");
    await expect(lowCheckbox).toHaveAttribute("data-state", "checked");
    await expect(mediumCheckbox).toHaveAttribute("data-state", "checked");

    // A individual reasoning checkbox click flips just that one combo;
    // the Router toggle stays ON (still some checks), and a "partial"
    // badge appears because not all of the supported levels are checked.
    await mediumCheckbox.click();
    await expect(routerToggle).toHaveAttribute("data-state", "checked");
    await expect(lowCheckbox).toHaveAttribute("data-state", "checked");
    await expect(mediumCheckbox).toHaveAttribute("data-state", "unchecked");
    await expect(page.getByTestId("registry-badge-partial-gpt-5.4-mini")).toBeVisible();
  });

  test("Registry: capability badges surface honest per-model reasoning surface (Codex + unknown)", async ({
    page,
  }) => {
    // Regression for the brief:
    //   - Codex models must NOT be hardcoded to `["low"]`; they should
    //     advertise the per-model set (gpt-5.5/gpt-5.4 → all three,
    //     gpt-5.4-mini → low/medium, gpt-5.3-codex-spark → low only).
    //   - Discovered-only OpenAI models must NOT pretend to support
    //     only `low`; their reasoning column must show "unknown".
    //   - MiniMax models must NOT show the effort-level picker; their
    //     capability is `thinking_budget`.
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    // gpt-5.4-mini Codex variant surfaces all three per-model levels:
    // cheap tier → low + medium, NO high.
    await expect(page.getByTestId("registry-reasoning-codex:gpt-5.4-mini-low")).toBeVisible();
    await expect(page.getByTestId("registry-reasoning-codex:gpt-5.4-mini-medium")).toBeVisible();
    await expect(page.getByTestId("registry-reasoning-codex:gpt-5.4-mini-high")).toHaveCount(0);

    // gpt-5.5 Codex variant is expensive-tier and advertises all three.
    await expect(page.getByTestId("registry-reasoning-codex:gpt-5.5-low")).toBeVisible();
    await expect(page.getByTestId("registry-reasoning-codex:gpt-5.5-medium")).toBeVisible();
    await expect(page.getByTestId("registry-reasoning-codex:gpt-5.5-high")).toBeVisible();

    // Discovered-only OpenAI models get the "unknown" capability, NOT
    // a faked `low` checkbox. The Reasoning column shows "Not supported"
    // (or an explicit "unknown" notice — see
    // `components/settings/router-settings-page.tsx`); the registry
    // MUST NOT render a `registry-reasoning-gpt-fake-unknown-xyz-*`
    // checkbox because that would be the lie this refactor removed.
    await expect(page.getByTestId("registry-reasoning-gpt-fake-unknown-xyz-low")).toHaveCount(0);
    await expect(page.getByTestId("registry-reasoning-gpt-fake-unknown-xyz-medium")).toHaveCount(0);
    await expect(page.getByTestId("registry-reasoning-gpt-fake-unknown-xyz-high")).toHaveCount(0);
  });
});
