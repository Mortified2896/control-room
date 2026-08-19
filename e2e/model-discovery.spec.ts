import { expect, test } from "@playwright/test";

/**
 * E2E for the post-split `/settings/router` UI — focused on
 *   - Tab A · Manual chat picker (visibility filter)
 *   - Tab C · Recommender candidates (per-row controls)
 *   - Discovery summary (counts)
 *
 * Run with the Playwright config (which sets CONTROL_ROOM_FAKE_LLM=1
 * and CONTROL_ROOM_FAKE_OPENAI_MODELS=1) so the discovery path uses
 * the deterministic fake ids and no real OpenAI call is made.
 *
 * Tab C row semantics:
 *   - "Allow recommender" Switch (per-row) toggles the model id into /
 *     out of `normalChatRecommenderAllowedModels`.
 *   - Per-level reasoning checkboxes (per-row) toggle entries in /
 *     out of `allowedCombos`.
 *   - Unconfigured / unavailable rows show a locked `Disabled` chip.
 *
 * Tier pill / capability column / fallback section are intentionally
 * absent from the new tabs (the brief: "Remove STANDARD/EXPENSIVE
 * from the main visible table"). Re-introducing them would now be a
 * regression.
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

test.describe("Discovery + manual picker + recommender candidates", () => {
  test.afterEach(async () => {
    await cleanup("http://127.0.0.1:3100");
  });

  test("Discovery section renders the plain-English summary in fake mode", async ({ page }) => {
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

    // Section 0: discovery + fake banner + plain-English summary.
    await expect(page.getByTestId("router-settings-section-discovery")).toBeVisible();
    await expect(page.getByTestId("discovery-fake-banner")).toBeVisible();
    await expect(page.getByTestId("discovery-summary")).toBeVisible();
    // The fake mode is on, but the DB may have stale real-model
    // discovery rows from previous runs in dev. We assert the 4 fake
    // ids always render regardless of stale rows; the count is non-zero.
    const discoveredSummary = await page.getByTestId("discovery-summary-discovered").textContent();
    expect(discoveredSummary).toMatch(/\d+/);
    expect(Number((discoveredSummary ?? "").match(/(\d+)/)?.[1] ?? "0")).toBeGreaterThanOrEqual(4);
    await expect(page.getByTestId("discovery-refresh-button")).toBeVisible();

    // Tab A — Manual chat picker renders all 4 fake ids with search.
    const manualSection = page.getByTestId("router-settings-section-manual-picker");
    await expect(manualSection).toBeVisible();
    await expect(manualSection.getByTestId("registry-search")).toBeVisible();
    await expect(manualSection.getByTestId("registry-filter")).toBeVisible();
    for (const id of FAKE_FOUR_IDS) {
      await expect(manualSection.getByTestId(`registry-row-${id}`)).toBeVisible();
      await expect(manualSection.getByTestId(`registry-manual-toggle-${id}`)).toBeVisible();
      await expect(manualSection.getByTestId(`registry-status-pill-${id}`)).toBeVisible();
      await expect(manualSection.getByTestId(`registry-billing-tag-${id}`)).toBeVisible();
    }

    // Tier pills are NOT in the new main UI.
    await expect(page.getByTestId("registry-tier-pill-gpt-5.4-mini")).toHaveCount(0);
    await expect(page.getByTestId("registry-tier-pill-gpt-5.5")).toHaveCount(0);

    // Console + network sanity.
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

  test("Tab A: hiding a configured model removes it from /api/models", async ({
    page,
    request,
  }) => {
    // In fake mode without OPENAI_API_KEY the picker hides OpenAI
    // models by default; explicitly opt the model in via the prefs API.
    await request.put("/api/model-selector-prefs", {
      data: { preferences: { "gpt-5.4-mini": { visible: true } } },
    });

    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    await expect(
      page
        .getByTestId("router-settings-section-manual-picker")
        .getByTestId("registry-row-gpt-5.4-mini"),
    ).toBeVisible();

    const initial = await request.get("/api/models");
    expect(initial.status()).toBe(200);
    const initialBody = await initial.json();
    const initialIds = (initialBody.models ?? []).map((m: { modelId: string }) => m.modelId);
    expect(initialIds).toContain("gpt-5.4-mini");

    const toggle = page.getByTestId("registry-manual-toggle-gpt-5.4-mini");
    await expect(toggle).toBeVisible();
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

    // The toggled-off model remains in the Settings tables (both tabs)
    // so the user can re-enable it.
    await expect(
      page
        .getByTestId("router-settings-section-manual-picker")
        .getByTestId("registry-row-gpt-5.4-mini"),
    ).toBeVisible();

    // Re-enable + verify /api/models restores the row.
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

  test("Tab C: unknown / unclassified fake model cannot enter the recommender allowlist", async ({
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

  test("Tab A: can be set independently of Tab C candidate pool", async ({ page, request }) => {
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    // Hide a model from manual picker.
    await page.getByTestId("registry-manual-toggle-gpt-5.4-mini").click();
    await page.waitForTimeout(500);

    // /api/models no longer includes it.
    const modelsRes = await request.get("/api/models");
    const ids = ((await modelsRes.json()).models ?? []).map((m: { modelId: string }) => m.modelId);
    expect(ids).not.toContain("gpt-5.4-mini");

    // Tab C candidate pool is unaffected — we can still save a non-empty
    // allowedCombos for that model (the runtime recommender reads the
    // Tab C settings, not the picker prefs).
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

    // Confirm the prefs persisted the hide.
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

    await page
      .getByTestId("router-settings-section-recommender-candidates")
      .getByTestId("registry-reasoning-gpt-5.4-mini-medium")
      .click();
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

  test("Tab C: search + filter narrow the candidates", async ({ page }) => {
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    // Scope the search to the candidates tab by using its search input.
    const candidatesSection = page.getByTestId("router-settings-section-recommender-candidates");
    await candidatesSection.getByTestId("registry-search").fill("fake-unknown");
    // The DB may contain stale real-model discovery rows; the
    // `gpt-fake-unknown-xyz` row must still surface from the search.
    await expect(candidatesSection.getByTestId("registry-row-gpt-fake-unknown-xyz")).toBeVisible();
    await expect(candidatesSection.getByTestId("registry-row-gpt-5.4-mini")).toHaveCount(0);

    await candidatesSection.getByTestId("registry-search").fill("");
  });

  test("Tab C: capability surface is honest per-model (no fake 'low')", async ({ page }) => {
    // Codex models must surface their full per-model reasoning set; the
    // MiniMax-M3 thinking-budget modes must show as a non-effort-level
    // column; unknown MiniMax / unknown OpenAI must NOT fake a single
    // 'low' option. Use the recommender-candidates tab to inspect the
    // rows.
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    // gpt-5.4-mini Codex variant surfaces low + medium at minimum.
    await expect(page.getByTestId("registry-reasoning-codex:gpt-5.4-mini-low")).toBeVisible();
    await expect(page.getByTestId("registry-reasoning-codex:gpt-5.4-mini-medium")).toBeVisible();

    // gpt-5.5 Codex variant advertises low + medium at minimum
    // (high may be present depending on the static alias map version).
    await expect(page.getByTestId("registry-reasoning-codex:gpt-5.5-low")).toBeVisible();
    await expect(page.getByTestId("registry-reasoning-codex:gpt-5.5-medium")).toBeVisible();

    // Unknown OpenAI models expose NO reasoning checkboxes (we never
    // fake options for `unknown` capabilities).
    await expect(page.getByTestId("registry-reasoning-gpt-fake-unknown-xyz-low")).toHaveCount(0);
    await expect(page.getByTestId("registry-reasoning-gpt-fake-unknown-xyz-medium")).toHaveCount(0);
    await expect(page.getByTestId("registry-reasoning-gpt-fake-unknown-xyz-high")).toHaveCount(0);
  });
});
