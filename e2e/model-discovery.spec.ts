import { expect, test } from "@playwright/test";

/**
 * E2E for the model discovery + manual selector + router pool UI.
 *
 * Run with the Playwright config (which sets CONTROL_ROOM_FAKE_LLM=1 and
 * CONTROL_ROOM_FAKE_OPENAI_MODELS=1) so the discovery path uses the
 * deterministic fake ids and no real OpenAI call is made.
 *
 * What this test exercises (after the UX refactor):
 *   - Section A (OpenAI Model Discovery) renders the plain-English
 *     summary: discovered / configured / unclassified counts.
 *   - Section B (Manual Model Selector) lists every discovered fake
 *     id, separates OpenAI availability from Control Room
 *     configuration (two stacked columns per row), tags the unknown
 *     fake id as "unclassified" (renamed from "unknown"), renders
 *     capability placeholders, supports sort + filter + search, and
 *     allows opting in to an unclassified model.
 *   - Section C (Router Recommendation Pool) still renders the cheap
 *     combo checkboxes, and the unclassified fake id is excluded (it
 *     cannot enter the pool).
 *   - /api/models reflects the manual selector visibility.
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

test.describe("Model discovery + manual selector + router pool", () => {
  test.afterEach(async () => {
    await cleanup("http://127.0.0.1:3100");
  });

  test("/settings/router loads in fake mode with the redesigned UX", async ({ page }) => {
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

    // Section B: manual selector renders all 4 fake ids + sort/filter/search
    await expect(page.getByTestId("router-settings-section-selector")).toBeVisible();
    await expect(page.getByTestId("selector-search")).toBeVisible();
    await expect(page.getByTestId("selector-sort")).toBeVisible();
    await expect(page.getByTestId("selector-filter")).toBeVisible();
    for (const id of FAKE_FOUR_IDS) {
      await expect(page.getByTestId(`selector-row-${id}`)).toBeVisible();
    }
    // The unknown fake is tagged as "unclassified" (renamed from "unknown")
    await expect(
      page.getByTestId("selector-badge-unclassified-gpt-fake-unknown-xyz"),
    ).toBeVisible();
    // The fake badge still applies in fake mode
    await expect(page.getByTestId("selector-badge-fake-gpt-fake-unknown-xyz")).toBeVisible();
    // OpenAI + Control Room columns are separated per row
    await expect(page.getByTestId("selector-openai-pill-gpt-5.4-mini")).toBeVisible();
    await expect(page.getByTestId("selector-controlroom-pill-gpt-5.4-mini")).toBeVisible();
    // Capability placeholders are rendered (disabled)
    await expect(page.getByTestId("selector-gpt-5.4-mini-capability-reasoning")).toBeVisible();
    await expect(page.getByTestId("selector-gpt-5.4-mini-capability-vision")).toBeDisabled();
    await expect(page.getByTestId("selector-gpt-5.4-mini-capability-streaming")).toBeChecked();

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

    await expect(refreshButton).toBeEnabled({ timeout: 10_000 });
    await expect(page.getByTestId("discovery-error")).toHaveCount(0);
  });

  test("Hiding a configured model removes it from /api/models (manual selector visibility)", async ({
    page,
    request,
  }) => {
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.getByTestId("selector-row-gpt-5.4-mini")).toBeVisible();

    const initial = await request.get("/api/models");
    expect(initial.status()).toBe(200);
    const initialBody = await initial.json();
    const initialIds = (initialBody.models ?? []).map((m: { modelId: string }) => m.modelId);
    expect(initialIds).toContain("gpt-5.4-mini");

    const toggle = page.getByTestId("selector-toggle-gpt-5.4-mini");
    await expect(toggle).toBeVisible();
    await toggle.click();

    const after = await request.get("/api/models");
    expect(after.status()).toBe(200);
    const afterBody = await after.json();
    const afterIds = (afterBody.models ?? []).map((m: { modelId: string }) => m.modelId);
    expect(afterIds).not.toContain("gpt-5.4-mini");
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

    await expect(page.getByTestId("selector-row-gpt-5.4-mini")).toBeVisible();
    await page.getByTestId("selector-toggle-gpt-5.4-mini").click();
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

    await page.getByTestId("router-settings-combo-gpt-5.4-mini-medium").locator("button").click();
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

  test("Manual selector: sort + filter + search narrow the table", async ({ page }) => {
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    // Search "fake-unknown" should narrow to the one unknown fake
    await page.getByTestId("selector-search").fill("fake-unknown");
    await expect(page.getByTestId("selector-result-count")).toContainText(/Showing 1 of 4/);
    await expect(page.getByTestId("selector-row-gpt-fake-unknown-xyz")).toBeVisible();
    await expect(page.getByTestId("selector-row-gpt-5.4-mini")).toHaveCount(0);

    // Clear search and switch to "Configured only" filter
    await page.getByTestId("selector-search").fill("");
    await page.getByTestId("selector-filter").selectOption("configured");
    await expect(page.getByTestId("selector-result-count")).toContainText(/Showing 3 of 4/);
    await expect(page.getByTestId("selector-row-gpt-fake-unknown-xyz")).toHaveCount(0);

    // Switch to "Unclassified only" filter
    await page.getByTestId("selector-filter").selectOption("unclassified");
    await expect(page.getByTestId("selector-result-count")).toContainText(/Showing 1 of 4/);
    await expect(page.getByTestId("selector-row-gpt-fake-unknown-xyz")).toBeVisible();
  });

  test("Manual selector: unconfigured model can be opted in for experimentation", async ({
    page,
    request,
  }) => {
    // Default state: gpt-fake-unknown-xyz is unconfigured + available
    // but hidden from the picker.
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });
    // Filter to unclassified to find it easily.
    await page.getByTestId("selector-filter").selectOption("unclassified");
    const row = page.getByTestId("selector-row-gpt-fake-unknown-xyz");
    await expect(row).toBeVisible();
    // The Control Room column should show "Not configured"
    await expect(page.getByTestId("selector-controlroom-pill-gpt-fake-unknown-xyz")).toContainText(
      /Not configured/,
    );
    // The OpenAI column should show "Available"
    await expect(page.getByTestId("selector-openai-pill-gpt-fake-unknown-xyz")).toContainText(
      /Available/,
    );

    // Confirm /api/models does NOT include it before opt-in
    const before = await request.get("/api/models");
    const beforeBody = await before.json();
    const beforeIds = (beforeBody.models ?? []).map((m: { modelId: string }) => m.modelId);
    expect(beforeIds).not.toContain("gpt-fake-unknown-xyz");

    // Opt in via the toggle
    await page.getByTestId("selector-toggle-gpt-fake-unknown-xyz").click();
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

    // The "override" badge appears in the selector row after opt-in
    await expect(page.getByTestId("selector-badge-overridden-gpt-fake-unknown-xyz")).toBeVisible();

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
});
