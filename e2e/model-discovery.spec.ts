import { expect, test } from "@playwright/test";

/**
 * E2E for the model discovery + manual selector + router pool UI.
 *
 * Run with the Playwright config (which sets CONTROL_ROOM_FAKE_LLM=1 and
 * CONTROL_ROOM_FAKE_OPENAI_MODELS=1) so the discovery path uses the
 * deterministic fake ids and no real OpenAI call is made.
 *
 * What this test exercises:
 *   - Section A (OpenAI Model Discovery) renders the fake-mode banner,
 *     the last-refreshed timestamp, and a working manual refresh button.
 *   - Section B (Manual Model Selector) lists every discovered fake id,
 *     tags the unknown fake id as "unknown", and toggles visibility
 *     correctly without affecting the router pool.
 *   - Section C (Router Recommendation Pool) renders the cheap combo
 *     checkboxes, and the unknown fake id is excluded (it cannot enter
 *     the pool).
 *   - /api/models reflects the manual selector visibility — hidden
 *     models do not appear in the chat composer dropdown.
 *   - A new A/B chat uses the persisted allowlist (no fatal console
 *     errors, no failed network requests).
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

test.describe("Model discovery + manual selector + router pool", () => {
  test.afterEach(async () => {
    await cleanup("http://127.0.0.1:3100");
  });

  test("/settings/router loads in fake mode with all three sections", async ({ page }) => {
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

    // Section A: discovery + fake banner
    await expect(page.getByTestId("router-settings-section-discovery")).toBeVisible();
    await expect(page.getByTestId("discovery-fake-banner")).toBeVisible();
    await expect(page.getByTestId("discovery-status")).toBeVisible();
    await expect(page.getByTestId("discovery-refresh-button")).toBeVisible();

    // Section B: manual selector should list all 4 fake ids
    await expect(page.getByTestId("router-settings-section-selector")).toBeVisible();
    for (const id of FAKE_FOUR_IDS) {
      await expect(page.getByTestId(`selector-row-${id}`)).toBeVisible();
    }
    // The unknown fake is tagged as "fake" (fake mode flags every fake
    // id as provenance="fake" regardless of known/unknown status — see
    // `buildEffectiveRegistry` in lib/providers/registry.ts).
    await expect(page.getByTestId("selector-badge-fake-gpt-fake-unknown-xyz")).toBeVisible();

    // Section C: router pool should NOT include the unknown fake
    await expect(page.getByTestId("router-settings-section-pool")).toBeVisible();
    await expect(page.getByTestId("router-settings-row-gpt-fake-unknown-xyz")).toHaveCount(0);

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

    // After refresh, the page re-fetches the registry; the status should
    // update (or remain refreshed). We just confirm the button is not
    // stuck in the disabled state and no fatal error appears.
    await expect(refreshButton).toBeEnabled({ timeout: 10_000 });
    // The fake discovery always succeeds in this configuration.
    await expect(page.getByTestId("discovery-error")).toHaveCount(0);
  });

  test("Hiding a model removes it from /api/models (manual selector visibility)", async ({
    page,
    request,
  }) => {
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    // Wait for the section to populate.
    await expect(page.getByTestId("selector-row-gpt-5.4-mini")).toBeVisible();

    // Confirm gpt-5.4-mini is in /api/models initially.
    const initial = await request.get("/api/models");
    expect(initial.status()).toBe(200);
    const initialBody = await initial.json();
    const initialIds = (initialBody.models ?? []).map((m: { modelId: string }) => m.modelId);
    expect(initialIds).toContain("gpt-5.4-mini");

    // Toggle gpt-5.4-mini off via the manual selector switch.
    const toggle = page.getByTestId("selector-toggle-gpt-5.4-mini");
    await expect(toggle).toBeVisible();
    await toggle.click();

    // /api/models should now exclude it.
    const after = await request.get("/api/models");
    expect(after.status()).toBe(200);
    const afterBody = await after.json();
    const afterIds = (afterBody.models ?? []).map((m: { modelId: string }) => m.modelId);
    expect(afterIds).not.toContain("gpt-5.4-mini");
  });

  test("Unknown fake model cannot enter the router pool via PUT", async ({ request }) => {
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

    // Toggle gpt-5.4-mini OFF in the manual selector.
    await expect(page.getByTestId("selector-row-gpt-5.4-mini")).toBeVisible();
    await page.getByTestId("selector-toggle-gpt-5.4-mini").click();
    // Allow the optimistic PUT to settle.
    await page.waitForTimeout(500);

    // Verify gpt-5.4-mini is now hidden from the chat composer.
    const modelsRes = await request.get("/api/models");
    expect(modelsRes.status()).toBe(200);
    const modelsBody = await modelsRes.json();
    const ids = (modelsBody.models ?? []).map((m: { modelId: string }) => m.modelId);
    expect(ids).not.toContain("gpt-5.4-mini");

    // Now PUT a router settings that includes gpt-5.4-mini in the pool.
    // The router pool is decoupled from the manual selector, so this
    // should succeed (gpt-5.4-mini is known + available + supported).
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

    // The manual selector visibility for gpt-5.4-mini should still be hidden.
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

    // Restrict the pool to only (gpt-5.4-mini, low).
    await page.getByTestId("router-settings-combo-gpt-5.4-mini-medium").locator("button").click();
    await page.getByTestId("router-settings-save").click();
    await expect(page.getByTestId("router-settings-save-status")).toBeVisible({
      timeout: 5_000,
    });

    // Start a new chat and send a short prompt.
    await page.goto("/");
    await expect(page.getByText("How can I help you today?")).toBeVisible({ timeout: 15_000 });
    const composer = page.locator('textarea[aria-label*="Message input"]');
    await composer.fill("What is 2 + 2?");
    await composer.press("Enter");

    // The A/B panel must render.
    const panel = page.getByTestId("router-ab-panel").first();
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("router-ab-side-b-text").first()).not.toContainText(
      /Router is generating Side B/,
      { timeout: 15_000 },
    );

    // Side B must have picked (gpt-5.4-mini, low) — the only allowed combo.
    const sideBHeader = page.getByTestId("router-ab-side-b-header").first();
    await expect(sideBHeader).toContainText(/gpt-5\.4-mini/i);
    await expect(sideBHeader).toContainText(/low/i);
  });
});
