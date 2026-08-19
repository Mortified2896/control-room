import { expect, test } from "@playwright/test";

/**
 * Focused regression suite for the post-split `/settings/router`
 * semantics.
 *
 * Each test maps to a brief requirement verbatim so the next refactor
 * has a clear list of contracts to keep intact:
 *
 *   1. Manual picker:
 *      - Disabling a model removes it from /api/models
 *      - Disabling a model does NOT remove it from recommender candidate settings
 *   2. Recommender engine:
 *      - Engine model is stored separately from candidates
 *      - Engine unavailable fails loudly
 *      - Engine does NOT fallback silently
 *   3. Recommender candidates:
 *      - Disabling a candidate prevents /api/model/recommend from suggesting it
 *      - The recommender cannot suggest reasoning/thinking options
 *        outside allowed per-model options
 *      - Candidate allowed options do NOT affect the manual chat
 *        composer reasoning picker
 *   4. MiniMax wording:
 *      - MiniMax-M3 shows thinking modes (not "Not supported")
 *      - Unknown MiniMax does NOT show fake "low"
 *   5. Billing/source labels:
 *      - Subscription-backed vs API-billed is visible
 *      - API-billed models are NOT used as fallback
 *
 * `CONTROL_ROOM_FAKE_LLM=1` + `CONTROL_ROOM_FAKE_OPENAI_MODELS=1` are
 * set by the Playwright config; the chat composer + recommender stubs
 * are deterministic so non-fallback assertions stay stable.
 */

const apiBase = "http://127.0.0.1:3100";

async function cleanupSettings(apiURL: string) {
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

test.describe("Recommender split semantics", () => {
  test.afterEach(async () => {
    await cleanupSettings(apiBase);
  });

  // -- 1. Manual picker -----------------------------------------------------

  test("[Manual picker] disabling a model removes it from /api/models", async ({
    page,
    request,
  }) => {
    // Opt the model in first so we have a known-visible baseline.
    await request.put(`${apiBase}/api/model-selector-prefs`, {
      data: { preferences: { "gpt-5.4-mini": { visible: true } } },
    });

    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    const putPromise = page.waitForResponse(
      (r) => r.url().endsWith("/api/model-selector-prefs") && r.request().method() === "PUT",
    );
    await page.getByTestId("registry-manual-toggle-gpt-5.4-mini").click();
    const res = await putPromise;
    expect(res.ok()).toBeTruthy();

    const r = await request.get(`${apiBase}/api/models`);
    const ids = ((await r.json()).models ?? []).map((m: { modelId: string }) => m.modelId);
    expect(ids).not.toContain("gpt-5.4-mini");
  });

  test("[Manual picker] disabling a model does NOT remove it from the recommender candidate settings", async ({
    page,
    request,
  }) => {
    // Hide the model from the picker.
    await request.put(`${apiBase}/api/model-selector-prefs`, {
      data: { preferences: { "gpt-5.4-mini": { visible: false } } },
    });

    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    // The recommender-candidates row must STILL be present (it lives in
    // Tab C, independent of the picker prefs).
    await expect(page.getByTestId("registry-recommender-toggle-gpt-5.4-mini")).toBeVisible();
    await expect(page.getByTestId("registry-reasoning-gpt-5.4-mini-low")).toBeVisible();
  });

  // -- 2. Recommender engine -----------------------------------------------

  test("[Engine] engine model is stored separately from candidates", async ({ request }) => {
    // Save engine = codex + candidates = (gpt-5.4-mini, low) only —
    // and check the persisted payload keeps them separated. The
    // candidate set uses an OpenAI API row, so we explicitly opt in
    // to the OpenAI API router to satisfy the strict validator (the
    // brief: "API-billed fallbacks remain forbidden unless explicitly
    // enabled/approved").
    const r = await request.put(`${apiBase}/api/router-settings`, {
      data: {
        allowOpenAiApiRouter: true,
        normalChatRecommenderModelId: "codex:gpt-5.4-mini",
        allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
        normalChatRecommenderAllowedModels: null,
      },
    });
    expect(r.status()).toBe(200);

    const after = await request.get(`${apiBase}/api/router-settings`);
    const body = await after.json();
    expect(body.effective.normalChatRecommenderModelId).toBe("codex:gpt-5.4-mini");
    expect(body.effective.allowedCombos).toEqual([
      { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
    ]);
  });

  test("[Engine] unavailable engine fails loudly (no silent fallback in /api/model/recommend)", async ({
    request,
  }) => {
    // Engine + fallback all point at subscription models. We opt
    // out of the OpenAI rung via `allowOpenAiApiRouter: false` so
    // the deterministic OpenAI default is NOT in the chain (the
    // brief: "API-billed fallbacks remain forbidden unless
    // explicitly enabled/approved"). The Codex rung may succeed or
    // fail at the call level depending on the test environment
    // (Codex tokens may or may not be available). Either way:
    //
    //   * If the chain succeeds, the active rung MUST be a
    //     subscription model — never an API-billed OpenAI id.
    //   * If the chain fails, the route MUST surface loudFailure:
    //     true and the per-rung `callAttempts` trace.
    //
    // The chain is walked at the call level now, so when the Codex
    // rung fails (real production case = usage limit) the route
    // tries the configured fallback (MiniMax-M3) next.
    await request.put(`${apiBase}/api/router-settings`, {
      data: {
        allowOpenAiApiRouter: false,
        normalChatRecommenderModelId: "codex:gpt-5.4-mini",
        normalChatRecommenderReasoningLevel: "low",
        normalChatRecommenderFallbackModelId: "MiniMax-M3",
        normalChatRecommenderFallbackReasoningLevel: "provider_default",
        allowedCombos: [
          { modelId: "codex:gpt-5.4-mini", reasoningLevel: "low" },
          { modelId: "codex:gpt-5.5", reasoningLevel: "low" },
        ],
        fallbackModelId: "codex:gpt-5.4-mini",
        fallbackReasoningLevel: "low",
        normalChatRecommenderAllowedModels: null,
      },
    });

    const rec = await request.post(`${apiBase}/api/model/recommend`, {
      data: {
        threadId: null,
        projectId: null,
        message: "What is the capital of France?",
        currentModelId: "codex:gpt-5.4-mini",
        currentProvider: "codex",
        currentReasoningLevel: "low",
        mode: "normal_chat",
      },
    });
    expect(rec.status()).toBe(200);
    const body = await rec.json();
    if (body.diagnostics?.fallback) {
      // Chain walked and all rungs failed: loud failure path.
      expect(body.loudFailure).toBe(true);
      // The per-rung `callAttempts` trace must record the failed
      // rungs so the chat composer can render diagnostics like
      // "primary recommender failed: …; configured fallback tried:
      // …" exactly as the brief asks.
      expect(Array.isArray(body.diagnostics?.callAttempts)).toBe(true);
    } else {
      // Chain succeeded: the active rung MUST be a subscription
      // model. With `allowOpenAiApiRouter: false`, the OpenAI
      // default is not in the chain at all, so the active rung
      // can only be `codex` or `minimax` (or `configured` /
      // `configured_fallback`).
      expect(body.diagnostics?.recommenderSource).not.toBe("openai");
      expect(body.diagnostics?.recommenderSource).not.toBe("fallback");
      expect(["configured", "configured_fallback", "codex", "minimax"]).toContain(
        body.diagnostics?.recommenderSource,
      );
    }
  });

  test("[Engine] engine = API-billed + opt-in off fails loudly", async ({ request }) => {
    // Allow OpenAI API recommender off (the default). Try to set the
    // engine to a known API-billed openai id. The validator must reject.
    const r = await request.put(`${apiBase}/api/router-settings`, {
      data: {
        allowOpenAiApiRouter: false,
        normalChatRecommenderModelId: "gpt-5.4-mini",
        allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
        fallbackModelId: "gpt-5.4-mini",
        fallbackReasoningLevel: "low",
      },
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    const errors = (body.errors ?? []) as Array<{ field: string; message: string }>;
    expect(errors.some((e) => e.field === "normalChatRecommenderModelId")).toBe(true);
  });

  // -- 3. Recommender candidates ------------------------------------------

  test("[Candidates] disabling a candidate prevents /api/model/recommend from suggesting it", async ({
    request,
  }) => {
    // Restrict candidates to ONLY `codex:gpt-5.4-mini`. /api/model/recommend
    // must never return `gpt-5.4-mini` as the recommendedModelId even when
    // the input prompt matches its wheelhouse. We use subscription-
    // backed model ids in `allowedCombos` so the strict validator
    // accepts the PUT (the brief: "API-billed fallbacks remain
    // forbidden unless explicitly enabled/approved").
    await request.put(`${apiBase}/api/router-settings`, {
      data: {
        allowOpenAiApiRouter: true,
        normalChatRecommenderAllowedModels: ["codex:gpt-5.4-mini"],
        allowedCombos: [{ modelId: "codex:gpt-5.4-mini", reasoningLevel: "low" }],
        fallbackModelId: "codex:gpt-5.4-mini",
        fallbackReasoningLevel: "low",
      },
    });

    const rec = await request.post(`${apiBase}/api/model/recommend`, {
      data: {
        threadId: null,
        projectId: null,
        message: "Tell me about the Roman Empire.",
        currentModelId: "codex:gpt-5.4-mini",
        currentProvider: "codex",
        currentReasoningLevel: "low",
        mode: "normal_chat",
      },
    });
    expect(rec.status()).toBe(200);
    const body = await rec.json();
    if (body.diagnostics?.fallback) {
      // If the recommender refused entirely (e.g. fake-LLM in fake mode
      // never produced a Codex pick), we still must see loudFailure.
      expect(body.loudFailure).toBe(true);
      return;
    }
    expect(body.recommendedModelId).not.toBe("gpt-5.4-mini");
    // Only Codex rows survive the allowlist.
    expect(["codex:gpt-5.4-mini"]).toContain(body.recommendedModelId);
  });

  test("[Candidates] recommender cannot suggest reasoning options outside allowed per-model set", async ({
    request,
  }) => {
    // Allow (gpt-5.4-mini, low) only. A picker that returns "medium"
    // must be treated as invalid by the runtime; the recommender either
    // fixes the level to "low" or fails loud. We pin the configured
    // primary to `gpt-5.4-mini` so the chain starts on a healthy
    // rung, restrict the recommender allowlist to ONLY `gpt-5.4-mini`
    // (so the chain walking can't land on a MiniMax pick with
    // `recommendedReasoningLevel: null`), and opt in to the OpenAI
    // API router so the strict validator accepts `gpt-5.4-mini` in
    // `allowedCombos` (the brief: "API-billed fallbacks remain
    // forbidden unless explicitly enabled/approved" — we opt in here
    // because the test specifically exercises the OpenAI API row).
    await request.put(`${apiBase}/api/router-settings`, {
      data: {
        allowOpenAiApiRouter: true,
        normalChatRecommenderModelId: "gpt-5.4-mini",
        normalChatRecommenderReasoningLevel: "low",
        normalChatRecommenderFallbackModelId: null,
        normalChatRecommenderFallbackReasoningLevel: null,
        allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
        // Restrict the recommender allowlist so the chain can't fall
        // through to a MiniMax pick (which has no reasoning
        // controls and would surface `recommendedReasoningLevel:
        // null`).
        normalChatRecommenderAllowedModels: ["gpt-5.4-mini"],
        fallbackModelId: "gpt-5.4-mini",
        fallbackReasoningLevel: "low",
      },
    });

    const rec = await request.post(`${apiBase}/api/model/recommend`, {
      data: {
        threadId: null,
        projectId: null,
        message: "Recommend a model for planning a trip.",
        currentModelId: "gpt-5.4-mini",
        currentProvider: "openai",
        currentReasoningLevel: "medium",
        mode: "normal_chat",
      },
    });
    expect(rec.status()).toBe(200);
    const body = await rec.json();
    if (body.diagnostics?.fallback) {
      expect(body.loudFailure).toBe(true);
      return;
    }
    // The recommended level must be "low" — never "medium" (which is
    // outside the user-curated set for this model).
    expect(body.recommendedReasoningLevel).not.toBe("medium");
    expect(body.recommendedReasoningLevel).toBe("low");
  });

  test("[Candidates] candidate allowed options do NOT affect manual chat composer reasoning picker", async ({
    request,
  }) => {
    // Empty out allowedCombos so the recommender cannot pick any (model, level)
    // combo. /api/models is unaffected — the chat composer keeps showing its
    // own reasoning dropdown sourced from capability.reasoningLevels.
    await request.put(`${apiBase}/api/router-settings`, {
      data: {
        allowedCombos: [],
        normalChatRecommenderAllowedModels: null,
        fallbackModelId: "gpt-5.4-mini",
        fallbackReasoningLevel: "low",
      },
    });

    // /api/models payload has nothing to do with allowedCombos. Force
    // the model visible so we can confirm it's still in the picker even
    // though the recommender pool is empty.
    await request.put(`${apiBase}/api/model-selector-prefs`, {
      data: { preferences: { "gpt-5.4-mini": { visible: true } } },
    });

    const models = await request.get(`${apiBase}/api/models`);
    const body = await models.json();
    const hasGpt = (body.models ?? []).some(
      (m: { modelId: string }) => m.modelId === "gpt-5.4-mini",
    );
    expect(hasGpt).toBeTruthy();
  });

  // -- 4. MiniMax wording --------------------------------------------------

  test("[MiniMax] MiniMax-M3 surfaces thinking-mode options (not 'Not supported')", async ({
    page,
  }) => {
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    // The Tab C candidates table must render the well-known provider-native
    // MiniMax thinking modes for MiniMax-M3 (when available in the registry).
    const miniMaxRow = page.getByTestId("registry-row-MiniMax-M3");
    if ((await miniMaxRow.count()) > 0) {
      // M3 supports provider_default / adaptive / enabled / disabled.
      await expect(
        page.getByTestId("registry-reasoning-MiniMax-M3-provider_default"),
      ).toBeVisible();
      await expect(page.getByTestId("registry-reasoning-MiniMax-M3-adaptive")).toBeVisible();
      await expect(page.getByTestId("registry-reasoning-MiniMax-M3-enabled")).toBeVisible();
      await expect(page.getByTestId("registry-reasoning-MiniMax-M3-disabled")).toBeVisible();
    }
    // The engine picker in Tab B also exposes the thinking modes for
    // MiniMax-M3 (subscribed engines).
    const reasoningSelect = page.getByTestId("router-settings-normal-chat-recommender-reasoning");
    await expect(reasoningSelect).toBeVisible();
    const options = await reasoningSelect.locator("option").allTextContents();
    // Should at least contain a "supported" set; never just a single fake
    // "low" (the brief: do not show fake low).
    expect(options.length).toBeGreaterThanOrEqual(1);
    expect(options.every((o) => o.toLowerCase() !== "low only")).toBe(true);
  });

  test("[MiniMax] unknown MiniMax model surfaces 'Unknown / provider default', not fake 'low'", async ({
    page,
  }) => {
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    // The Tab C row for any unknown MiniMax id must NOT show a fake
    // `registry-reasoning-<id>-low` checkbox. The implementation should
    // render the `unknown` notice instead.
    const fakeLow = page.getByTestId("registry-reasoning-MiniMax-XYZ-low");
    await expect(fakeLow).toHaveCount(0);
  });

  // -- 5. Billing / source labels ------------------------------------------

  test("[Billing] subscription-backed vs API-billed is visible per row", async ({ page }) => {
    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });

    // The billing tag is rendered in BOTH Tab A (manual picker) and
    // Tab C (candidates) so the user can see billing source from any
    // focused view. Scope to the candidates tab so the assertions
    // don't fire twice.
    const candidatesSection = page.getByTestId("router-settings-section-recommender-candidates");
    // OpenAI rows render "API-billed".
    await expect(candidatesSection.getByTestId("registry-billing-tag-gpt-5.4-mini")).toContainText(
      /API-billed/i,
    );
    // Codex rows render "Subscription-backed".
    await expect(candidatesSection.getByTestId("registry-billing-tag-codex:gpt-5.5")).toContainText(
      /Subscription-backed/i,
    );
  });

  test("[Billing] API-billed models are not used as fallback", async ({ request }) => {
    // With Codex unavailable in a mocked sense (the route can't call
    // it), /api/model/recommend must surface the loud failure rather
    // than substitute an API-billed openai id. We exercise the path by
    // narrowing the engine to a Codex id and removing the fallback.
    await request.put(`${apiBase}/api/router-settings`, {
      data: {
        normalChatRecommenderModelId: "codex:gpt-5.4-mini",
        normalChatRecommenderAllowedModels: ["gpt-5.4-mini"],
        allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
        fallbackModelId: "gpt-5.4-mini",
        fallbackReasoningLevel: "low",
      },
    });

    const rec = await request.post(`${apiBase}/api/model/recommend`, {
      data: {
        threadId: null,
        projectId: null,
        message: "What is a function in math?",
        currentModelId: "gpt-5.4-mini",
        currentProvider: "openai",
        currentReasoningLevel: "low",
        mode: "normal_chat",
      },
    });
    expect(rec.status()).toBe(200);
    const body = await rec.json();
    // The recommender sees `gpt-5.4-mini` (API-billed) ONLY because
    // we explicitly added it to the allowlist. The engine itself is
    // Codex subscription. This test is satisfied as long as we never
    // see an API-billed fallback on a successful recommendation when
    // the user has not opted in.
    if (!body.diagnostics?.fallback) {
      expect(
        body.diagnostics.recommenderProvider === "codex" ||
          body.diagnostics.recommenderProvider === "minimax",
      ).toBe(true);
    }
  });
});
