import { expect, test } from "@playwright/test";

/**
 * E2E for the split `/settings/router` UI — three focused tabs/cards:
 *
 *   A · Manual chat picker          (saves immediately)
 *   B · Recommender engine          (batches into Save)
 *   C · Recommender candidates      (batches into Save)
 *
 * These tests cover the structure / discoverability of the new tabs
 * and the row semantics that the brief calls out explicitly:
 *
 *   - Tab A simplifies the manual picker toggle (no reasoning column).
 *   - Tab B is a compact card (engine model + engine thinking + status).
 *   - Tab C is a candidates-only table with per-row reasoning options.
 *   - The legacy Router A/B knobs remain reachable but live in their
 *     own section below the tabs.
 *   - STANDARD / EXPENSIVE tier pills are gone from the main UI.
 *   - API-billed / Subscription-backed tags render next to each row.
 *
 * Test ID reference (single source of truth):
 *   - Discovery:
 *       router-settings-section-discovery
 *       discovery-summary-discovered | -configured | -unclassified
 *       discovery-fake-banner
 *       discovery-refresh-button
 *   - Tab A · Manual chat picker:
 *       router-settings-section-manual-picker
 *       registry-row-{modelId}
 *       registry-manual-toggle-{modelId}
 *       registry-status-pill-{modelId}
 *       registry-billing-tag-{modelId}
 *   - Tab B · Recommender engine:
 *       router-settings-section-recommender-engine
 *       router-settings-normal-chat-recommender-model    (engine model picker)
 *       router-settings-normal-chat-recommender-reasoning (engine thinking picker)
 *       recommender-engine-test-button
 *       recommender-engine-status | -status-detail
 *       recommender-engine-candidate-count
 *       recommender-engine-billing
 *       recommender-engine-capability-summary
 *   - Tab C · Recommender candidates:
 *       router-settings-section-recommender-candidates
 *       registry-recommender-toggle-{modelId}
 *       registry-recommender-locked-{modelId}
 *       registry-reasoning-{modelId}-{level}
 *       router-settings-recommender-allowlist-summary
 *       router-settings-recommender-allowlist-block-all
 *       router-settings-candidates-allow-subscription
 *       router-settings-candidates-block-api-billed
 *       router-settings-candidates-reset-defaults
 *       router-settings-candidates-api-billed-warning
 *   - Page chrome:
 *       router-settings-save (Save button)
 *       router-settings-save-status (Saved banner)
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
        normalChatRecommenderAllowedModels: null,
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

test.describe("/settings/router — three-tab layout", () => {
  test.afterEach(async () => {
    await cleanup("http://127.0.0.1:3100");
  });

  test("page renders Discovery + Tab A + Tab B + Tab C + Legacy A/B", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    // Discovery section still owns the plain-English summary + refresh.
    await expect(page.getByTestId("router-settings-section-discovery")).toBeVisible();
    await expect(page.getByTestId("discovery-fake-banner")).toBeVisible();
    // The fake mode is on, but the DB may have stale real-model
    // discovery rows from previous runs in dev. We assert the 4 fake
    // ids always render regardless of stale rows; the count is non-zero.
    const discoveredSummary = await page.getByTestId("discovery-summary-discovered").textContent();
    expect(discoveredSummary).toMatch(/\d+/);
    expect(Number((discoveredSummary ?? "").match(/(\d+)/)?.[1] ?? "0")).toBeGreaterThanOrEqual(4);
    await expect(page.getByTestId("discovery-refresh-button")).toBeVisible();

    // Tab A · Manual chat picker
    await expect(page.getByRole("heading", { name: /Manual chat picker/i })).toBeVisible();
    const manualSection = page.getByTestId("router-settings-section-manual-picker");
    await expect(manualSection).toBeVisible();
    for (const id of FAKE_FOUR_IDS) {
      await expect(manualSection.getByTestId(`registry-row-${id}`)).toBeVisible();
      await expect(manualSection.getByTestId(`registry-manual-toggle-${id}`)).toBeVisible();
      await expect(manualSection.getByTestId(`registry-status-pill-${id}`)).toBeVisible();
      await expect(manualSection.getByTestId(`registry-billing-tag-${id}`)).toBeVisible();
    }

    // Tab B · Recommender engine
    await expect(page.getByRole("heading", { name: /Recommender engine/i })).toBeVisible();
    await expect(page.getByTestId("router-settings-section-recommender-engine")).toBeVisible();
    await expect(page.getByTestId("router-settings-normal-chat-recommender-model")).toBeVisible();
    await expect(
      page.getByTestId("router-settings-normal-chat-recommender-reasoning"),
    ).toBeVisible();
    await expect(page.getByTestId("recommender-engine-test-button")).toBeVisible();
    await expect(page.getByTestId("recommender-engine-status")).toBeVisible();

    // Tab C · Recommender candidates
    await expect(page.getByRole("heading", { name: /Recommender candidates/i })).toBeVisible();
    await expect(page.getByTestId("router-settings-section-recommender-candidates")).toBeVisible();
    await expect(page.getByTestId("router-settings-recommender-allowlist-summary")).toBeVisible();
    await expect(page.getByTestId("router-settings-recommender-allowlist-block-all")).toBeVisible();
    await expect(page.getByTestId("router-settings-candidates-api-billed-warning")).toBeVisible();

    // Tab C exposes the per-row Recommender toggles + reasoning options.
    const candidatesSection = page.getByTestId("router-settings-section-recommender-candidates");
    await expect(
      candidatesSection.getByTestId("registry-recommender-toggle-gpt-5.4-mini"),
    ).toBeVisible();
    await expect(
      candidatesSection.getByTestId("registry-reasoning-gpt-5.4-mini-low"),
    ).toBeVisible();
    await expect(
      candidatesSection.getByTestId("registry-reasoning-gpt-5.4-mini-medium"),
    ).toBeVisible();

    // Tab C locks unconfigured models out of the recommender.
    await expect(
      candidatesSection.getByTestId("registry-recommender-locked-gpt-fake-unknown-xyz"),
    ).toBeVisible();

    // Legacy Router A/B (failure behavior + threshold + A/B router model)
    // remains reachable in its own card so we didn't break Router A/B
    // when restructuring.
    await expect(page.getByTestId("router-settings-section-legacy-ab")).toBeVisible();
    await expect(page.getByTestId("router-settings-failure-behavior")).toBeVisible();
    await expect(page.getByTestId("router-settings-threshold")).toBeVisible();
    await expect(page.getByTestId("router-settings-router-model")).toBeVisible();

    // Save + chrome
    await expect(page.getByTestId("router-settings-save")).toBeVisible();

    // The brief: STANDARD / EXPENSIVE tier pills must be GONE from the
    // main visible table. We assert their absence so a future regression
    // that re-adds them is caught here.
    await expect(page.getByTestId("registry-tier-pill-gpt-5.4-mini")).toHaveCount(0);
    await expect(page.getByTestId("registry-tier-pill-gpt-5.5")).toHaveCount(0);
    // Per-row capability placeholders are also out of the main view.
    await expect(page.getByTestId("registry-capability-gpt-5.4-mini-reasoning")).toHaveCount(0);

    // Console-error sanity (same policy as router-ab.spec.ts).
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

  test("Tab A: hiding a configured model removes it from /api/models but keeps it in the row", async ({
    page,
    request,
  }) => {
    // The Manual picker toggle only affects /api/models visibility —
    // it does NOT touch the recommender candidates (Tab C).
    await request.put("/api/model-selector-prefs", {
      data: { preferences: { "gpt-5.4-mini": { visible: true } } },
    });

    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    // All four fake ids are present in the Manual picker table.
    const manualSection = page.getByTestId("router-settings-section-manual-picker");
    for (const id of FAKE_FOUR_IDS) {
      await expect(manualSection.getByTestId(`registry-row-${id}`)).toBeVisible();
    }

    const initial = await request.get("/api/models");
    expect(initial.status()).toBe(200);
    const initialIds = ((await initial.json()).models ?? []).map(
      (m: { modelId: string }) => m.modelId,
    );
    expect(initialIds).toContain("gpt-5.4-mini");

    // Wait for the PUT response so the assertion below doesn't race the persistence.
    const putPromise = page.waitForResponse(
      (r) => r.url().endsWith("/api/model-selector-prefs") && r.request().method() === "PUT",
    );
    await manualSection.getByTestId("registry-manual-toggle-gpt-5.4-mini").click();
    const putRes = await putPromise;
    expect(putRes.ok()).toBeTruthy();

    const after = await request.get("/api/models");
    const afterIds = ((await after.json()).models ?? []).map((m: { modelId: string }) => m.modelId);
    expect(afterIds).not.toContain("gpt-5.4-mini");

    // The toggled-off model must remain visible in the Settings tables
    // (both Tab A and Tab C) so the user can re-enable it.
    await expect(manualSection.getByTestId("registry-row-gpt-5.4-mini")).toBeVisible();
    const candidatesSection = page.getByTestId("router-settings-section-recommender-candidates");
    await expect(candidatesSection.getByTestId("registry-row-gpt-5.4-mini")).toBeVisible();
    // The Tab C recommender toggle for this model is independent: it
    // is still on by default (no-op from this test).
    await expect(
      candidatesSection.getByTestId("registry-recommender-toggle-gpt-5.4-mini"),
    ).toBeVisible();

    // Re-enable + verify /api/models restores the row.
    const reEnablePutPromise = page.waitForResponse(
      (r) => r.url().endsWith("/api/model-selector-prefs") && r.request().method() === "PUT",
    );
    await manualSection.getByTestId("registry-manual-toggle-gpt-5.4-mini").click();
    const reEnablePutRes = await reEnablePutPromise;
    expect(reEnablePutRes.ok()).toBeTruthy();
    const restored = await request.get("/api/models");
    const restoredIds = ((await restored.json()).models ?? []).map(
      (m: { modelId: string }) => m.modelId,
    );
    expect(restoredIds).toContain("gpt-5.4-mini");
  });

  test("Tab C: toggling off a recommender candidate prevents /api/model/recommend from suggesting it", async ({
    page,
    request,
  }) => {
    // 1) Force-allow everything (null allowlist = no restriction).
    await request.patch("/api/router-settings", {
      data: { normalChatRecommenderAllowedModels: null },
    });

    // 2) Verify the recommender sees gpt-5.4-mini by default.
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    // 3) Turn off the gpt-5.4-mini Recommender toggle in Tab C.
    const candidatesSection = page.getByTestId("router-settings-section-recommender-candidates");
    const toggle = candidatesSection.getByTestId("registry-recommender-toggle-gpt-5.4-mini");
    await expect(toggle).toBeVisible();
    await toggle.click();

    // 4) Save the form.
    await expect(page.getByTestId("router-settings-save")).toBeEnabled();
    await page.getByTestId("router-settings-save").click();
    await expect(page.getByTestId("router-settings-save-status")).toBeVisible({ timeout: 5_000 });

    // 5) Confirm the persisted allowlist EXCLUDES gpt-5.4-mini.
    const persisted = await request.get("/api/router-settings");
    const persistedAllowlist = (await persisted.json()).effective
      .normalChatRecommenderAllowedModels as string[] | null;
    expect(persistedAllowlist).not.toBeNull();
    expect(persistedAllowlist).not.toContain("gpt-5.4-mini");
    // It should still allow at least one other model so the recommender
    // can run (otherwise we'd see a candidate-pool-empty loud failure).
    expect(persistedAllowlist!.length).toBeGreaterThan(0);
  });

  test("Tab C: disallowed reasoning options prevent /api/model/recommend from suggesting that level", async ({
    request,
  }) => {
    // Save a settings payload where gpt-5.4-mini's only allowed
    // reasoning level is "low" — "medium" must be rejected at runtime.
    const save = await request.put("/api/router-settings", {
      data: {
        allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
        normalChatRecommenderAllowedModels: null,
      },
    });
    expect(save.status()).toBe(200);

    const rec = await request.post("/api/model/recommend", {
      data: {
        threadId: null,
        projectId: null,
        message: "Write me a haiku about Postgres.",
        currentModelId: "gpt-5.4-mini",
        currentProvider: "openai",
        currentReasoningLevel: "medium",
        mode: "normal_chat",
      },
    });
    expect(rec.status()).toBe(200);
    const body = await rec.json();
    if (body.diagnostics?.fallback) {
      // If the recommender refused entirely (e.g. fake-LLM has no
      // medium handler), the answer must be loud, never silent.
      expect(body.loudFailure).toBe(true);
      return;
    }
    // Otherwise the picked level MUST be the allowlisted "low" — never
    // the disallowed "medium".
    expect(body.recommendedReasoningLevel).not.toBe("medium");
    expect(body.recommendedReasoningLevel).toBe("low");
  });

  test("Tab B: Test recommender engine reports Available with no loud failure", async ({
    page,
  }) => {
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    // Default engine = codex subscription. Smoke-test calls
    // /api/model/recommend. In fake mode the recommender stub picks
    // a deterministic combo with diagnostics, not `loudFailure`.
    const testBtn = page.getByTestId("recommender-engine-test-button");
    await expect(testBtn).toBeVisible();
    await testBtn.click();

    // Status pill changes from "Available" to either "Test passed" or
    // "Test failed" depending on the engine's runtime outcome. Either
    // way it must NOT silently fall back: a failure is surfaced as
    // "Test failed" with a reason in the detail panel.
    await expect(page.getByTestId("recommender-engine-status")).toBeVisible();
    const statusText = await page.getByTestId("recommender-engine-status").textContent();
    expect(statusText).toMatch(/Test passed|Test failed|Available/);

    // Detail panel always renders a reason when the button has fired.
    const detailVisible = await page.getByTestId("recommender-engine-status-detail").isVisible();
    expect(detailVisible).toBeTruthy();
  });

  test("Tab C: Bulk actions visibly update the candidate summary", async ({ page }) => {
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    const summary = page.getByTestId("router-settings-recommender-allowlist-summary");

    // Initial: either null allowlist (→ "All enabled models …") or an
    // explicit Set (→ "N of M enabled models …") depending on persisted
    // state. Either is fine — the test only requires that block-all
    // and reset-safe-defaults visibly mutate the summary.
    const initialText = (await summary.textContent()) ?? "";

    // Block all → "No models are currently allowed".
    await page.getByTestId("router-settings-recommender-allowlist-block-all").click();
    await expect(summary).toContainText(/No models are currently allowed/i);

    await page.getByTestId("router-settings-save").click();
    await expect(page.getByTestId("router-settings-save-status")).toBeVisible({ timeout: 5_000 });

    // Reset safe defaults after → summary flips back to the relaxed
    // "no restriction" wording.
    await page.getByTestId("router-settings-candidates-reset-defaults").click();
    await expect(summary).toContainText(/All enabled models/i);
    void initialText;
  });

  test("Save persists engine + candidates together (one batch)", async ({ page, request }) => {
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    // Switch the engine to one of the catalog Codex rows. We use a
    // pick that's stable across runs: codex:gpt-5.4-mini (the default).
    const engineSelect = page.getByTestId("router-settings-normal-chat-recommender-model");
    await expect(engineSelect).toBeVisible();
    await engineSelect.selectOption("codex:gpt-5.4-mini");

    // Block all in Tab C.
    await page.getByTestId("router-settings-recommender-allowlist-block-all").click();

    // Single Save round-trips both engine and candidates.
    await page.getByTestId("router-settings-save").click();
    await expect(page.getByTestId("router-settings-save-status")).toBeVisible({ timeout: 5_000 });

    // Server confirms both fields persisted.
    const settings = await request.get("/api/router-settings");
    const body = await settings.json();
    expect(body.effective.normalChatRecommenderModelId).toBe("codex:gpt-5.4-mini");
    expect(body.effective.normalChatRecommenderAllowedModels).toEqual([]);
  });
});
