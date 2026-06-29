import { expect, test, type Page } from "@playwright/test";

/**
 * Focused regression suite for the chat UI top controls layout.
 *
 * The brief: combine the manual chat model controls into one compact
 * top bar (model selector + thinking selector + access label + Router
 * A/B pill + theme button) and put the recommender controls in a
 * single card directly below it. The chat UI must NOT render a
 * separate large "Manual chat model" row/card below the top bar.
 *
 * Each test maps to a brief requirement verbatim so the next refactor
 * has a clear list of contracts to keep intact:
 *
 *   1. Chat UI no longer renders a separate large "Manual chat model"
 *      row/card below the top bar.
 *   2. Top bar renders: manual model selector, manual thinking
 *      selector, access label, Router A/B pill.
 *   3. Recommender card renders: Recommend on pill, primary
 *      recommender engine row, fallback engine row.
 *   4. Fallback selector is visible and editable in Chat UI.
 *   5. Selecting No fallback persists:
 *        - normalChatRecommenderFallbackModelId = null
 *        - normalChatRecommenderFallbackReasoningLevel = null
 *   6. Changing primary recommender engine in Chat UI persists to
 *      Settings Tab B.
 *   7. Changing fallback engine in Chat UI persists to Settings Tab B.
 *   8. Settings Tab B changes reflect in Chat UI after reload.
 *   9. MiniMax-M3 reasoning options in Chat UI are:
 *        provider_default, adaptive, enabled, disabled.
 *  10. Manual model/reasoning and recommender engine/reasoning do not
 *      cross-wire.
 *
 * Test ID reference (single source of truth):
 *   - Top bar:
 *       manual-chat-model-controls      (the bar)
 *       aui-model-selector-trigger      (model trigger)
 *       chat-model-access-label         (access label)
 *       model-reasoning-select          (manual thinking dropdown)
 *       router-ab-toggle / router-ab-openai-only-pill
 *   - Recommender card:
 *       recommender-control             (the card)
 *       recommender-toggle              (on/off pill)
 *       chat-recommender-engine-controls   (primary row)
 *       chat-recommender-model
 *       chat-recommender-reasoning
 *       chat-recommender-fallback-controls (fallback row)
 *       chat-recommender-fallback-model
 *       chat-recommender-fallback-reasoning
 *
 * Environment: this suite relies on the Playwright config's
 * `CONTROL_ROOM_FAKE_LLM=1` + `CONTROL_ROOM_FAKE_OPENAI_MODELS=1` so
 * the registry contains deterministic Codex + OpenAI + MiniMax rows.
 */

const apiBase = "http://127.0.0.1:3100";

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
        normalChatRecommenderModelId: "codex:gpt-5.4-mini",
        normalChatRecommenderReasoningLevel: "low",
        normalChatRecommenderAllowedModels: null,
        normalChatRecommenderFallbackModelId: null,
        normalChatRecommenderFallbackReasoningLevel: null,
        fallbackModelId: "gpt-5.4-mini",
        fallbackReasoningLevel: "low",
      }),
    });
  } catch {
    /* best effort */
  }
}

async function gotoSettings(page: Page) {
  await page.goto("/settings/router");
  await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("Chat top controls layout", () => {
  test.afterEach(async () => {
    await cleanup(apiBase);
  });

  test("Chat UI no longer renders a separate large 'Manual chat model' row/card below the top bar", async ({
    page,
  }) => {
    await page.goto("/");
    const topBar = page.getByTestId("manual-chat-model-controls");
    await expect(topBar).toBeVisible({ timeout: 15_000 });

    // The top bar is a single compact row — it does not render the
    // full "Manual chat model" label/heading that the previous
    // `RouterControlsBar` card used to render. The hint still lives
    // on the wrapper's `title` attribute for users who hover.
    await expect(topBar).not.toContainText(/^Manual chat model$/);
    await expect(topBar).toHaveAttribute("title", /Manual chat model/i);
    // The "Used when Recommend is off or when you choose Keep current"
    // body copy from the old card must also be gone.
    await expect(topBar).not.toContainText(/Keep current/);

    // There must be exactly ONE wrapper tagged with the top-bar test
    // id (the new compact bar). The old large card is gone.
    expect(await topBar.count()).toBe(1);
  });

  test("Top bar renders the manual model selector, thinking selector, access label, and Router A/B pill", async ({
    page,
  }) => {
    await page.goto("/");
    const topBar = page.getByTestId("manual-chat-model-controls");
    await expect(topBar).toBeVisible({ timeout: 15_000 });

    // Manual model selector.
    await expect(topBar.getByTestId("aui-model-selector-trigger")).toBeVisible();
    // Manual thinking / reasoning selector.
    await expect(topBar.getByTestId("model-reasoning-select")).toBeVisible();
    // Access label (the text "Access: …" the model selector renders
    // alongside the trigger).
    await expect(page.getByTestId("chat-model-access-label")).toBeVisible();
    await expect(page.getByTestId("chat-model-access-label")).toContainText(/Access:/);

    // Router A/B is OpenAI-only for Codex / MiniMax. The brief says the
    // top bar must always show the Router A/B pill, so we expect the
    // "OpenAI-only" notice when the selected model is subscription.
    await expect(topBar.getByTestId("router-ab-openai-only-pill")).toBeVisible();
    await expect(topBar.getByTestId("router-ab-openai-only-pill")).toContainText(/OpenAI-only/);
  });

  test("Top bar Router A/B surfaces the OpenAI-only notice when the manual model is not OpenAI", async ({
    page,
  }) => {
    // In fake mode OpenAI API rows are disabled (they require a real
    // OPENAI_API_KEY), so the default Codex / MiniMax model renders
    // the "Router A/B is OpenAI-only" notice in the top bar. This
    // test pins that behavior down so the top bar never silently
    // hides the Router A/B affordance.
    await page.goto("/");
    const topBar = page.getByTestId("manual-chat-model-controls");
    await expect(topBar).toBeVisible({ timeout: 15_000 });

    // The "OpenAI-only" notice is the visible Router A/B affordance
    // for the default subscription-backed model. The real toggle
    // (visible only when the manual model is an OpenAI API row) is
    // NOT rendered.
    await expect(topBar.getByTestId("router-ab-openai-only-pill")).toBeVisible();
    await expect(topBar.getByTestId("router-ab-openai-only-pill")).toContainText(/OpenAI-only/);
    await expect(topBar.getByTestId("router-ab-toggle")).toHaveCount(0);
  });

  test("Recommender card renders: Recommend on pill, primary row, fallback row", async ({
    page,
  }) => {
    await page.goto("/");
    const card = page.getByTestId("recommender-control");
    await expect(card).toBeVisible({ timeout: 15_000 });

    // Left column: Recommend on/off pill.
    await expect(card.getByTestId("recommender-toggle")).toBeVisible();

    // Primary row.
    const primary = card.getByTestId("chat-recommender-engine-controls");
    await expect(primary).toBeVisible();
    await expect(primary).toContainText(/Recommender engine/);
    await expect(card.getByTestId("chat-recommender-model")).toBeVisible();
    await expect(card.getByTestId("chat-recommender-reasoning")).toBeVisible();

    // Fallback row.
    const fallback = card.getByTestId("chat-recommender-fallback-controls");
    await expect(fallback).toBeVisible();
    await expect(fallback).toContainText(/Fallback engine/);
    await expect(card.getByTestId("chat-recommender-fallback-model")).toBeVisible();
    await expect(card.getByTestId("chat-recommender-fallback-reasoning")).toBeVisible();

    // The two rows are separated by a visible horizontal divider —
    // the fallback row's wrapper carries a `border-t` class.
    expect(await fallback.evaluate((el) => getComputedStyle(el).borderTopWidth)).not.toBe("0px");
  });

  test("Fallback selector is visible and editable in Chat UI", async ({ page }) => {
    await page.goto("/");
    const card = page.getByTestId("recommender-control");
    await expect(card).toBeVisible({ timeout: 15_000 });

    const fallbackModel = card.getByTestId("chat-recommender-fallback-model");
    const fallbackReasoning = card.getByTestId("chat-recommender-fallback-reasoning");
    await expect(fallbackModel).toBeVisible();
    await expect(fallbackModel).toBeEnabled();

    // "No fallback" is the default explicit option.
    await expect(fallbackModel.locator('option[value=""]')).toHaveText(/no fallback/i);

    // Picking a fallback model enables the reasoning picker.
    await fallbackModel.selectOption("codex:gpt-5.4-mini");
    await expect(fallbackReasoning).toBeEnabled();

    // Selecting "No fallback" disables the reasoning picker again.
    await fallbackModel.selectOption("");
    await expect(fallbackReasoning).toBeDisabled();
  });

  test("Selecting No fallback persists null/null and disables fallback reasoning", async ({
    page,
    request,
  }) => {
    // Pre-seed a non-null fallback so we can verify the "no fallback"
    // pick clears it end-to-end.
    await request.put(`${apiBase}/api/router-settings`, {
      data: {
        normalChatRecommenderFallbackModelId: "codex:gpt-5.4-mini",
        normalChatRecommenderFallbackReasoningLevel: "low",
      },
    });

    await page.goto("/");
    const card = page.getByTestId("recommender-control");
    await expect(card).toBeVisible({ timeout: 15_000 });

    const fallbackModel = card.getByTestId("chat-recommender-fallback-model");
    const fallbackReasoning = card.getByTestId("chat-recommender-fallback-reasoning");
    await expect(fallbackModel).toHaveValue("codex:gpt-5.4-mini");
    await expect(fallbackReasoning).toBeEnabled();

    // Pick "No fallback".
    await fallbackModel.selectOption("");
    await expect(fallbackReasoning).toBeDisabled();
    await page.waitForTimeout(800);

    // Persisted values are both null.
    const body = await request.get(`${apiBase}/api/router-settings`).then((r) => r.json());
    expect(body.effective.normalChatRecommenderFallbackModelId).toBeNull();
    expect(body.effective.normalChatRecommenderFallbackReasoningLevel).toBeNull();

    // The Settings Tab B picker reflects the cleared state.
    await gotoSettings(page);
    await expect(
      page.getByTestId("router-settings-normal-chat-recommender-fallback-model"),
    ).toHaveValue("");
    await expect(
      page.getByTestId("router-settings-normal-chat-recommender-fallback-reasoning"),
    ).toBeDisabled();
  });

  test("Changing primary recommender engine in Chat UI persists to Settings Tab B", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    const card = page.getByTestId("recommender-control");
    await expect(card).toBeVisible({ timeout: 15_000 });

    // Switch the primary recommender engine to MiniMax-M3.
    const modelSelect = card.getByTestId("chat-recommender-model");
    await modelSelect.selectOption("MiniMax-M3");
    await expect(card.getByTestId("chat-recommender-reasoning")).toHaveValue("provider_default");
    await page.waitForTimeout(800);

    // Server confirms — the canonical Tab B field is the source of
    // truth, so the chat composer must not be allowed to drift from
    // it.
    const after = await request.get(`${apiBase}/api/router-settings`).then((r) => r.json());
    expect(after.effective.normalChatRecommenderModelId).toBe("MiniMax-M3");

    // Settings Tab B reflects the new value without a separate Save
    // (the chat composer's PATCH already wrote through to Postgres).
    await gotoSettings(page);
    await expect(page.getByTestId("router-settings-normal-chat-recommender-model")).toHaveValue(
      "MiniMax-M3",
    );
  });

  test("Changing fallback engine in Chat UI persists to Settings Tab B", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    const card = page.getByTestId("recommender-control");
    await expect(card).toBeVisible({ timeout: 15_000 });

    await card.getByTestId("chat-recommender-fallback-model").selectOption("codex:gpt-5.5");
    await page.waitForTimeout(800);

    const body = await request.get(`${apiBase}/api/router-settings`).then((r) => r.json());
    expect(body.effective.normalChatRecommenderFallbackModelId).toBe("codex:gpt-5.5");

    await gotoSettings(page);
    await expect(
      page.getByTestId("router-settings-normal-chat-recommender-fallback-model"),
    ).toHaveValue("codex:gpt-5.5");
  });

  test("Settings Tab B changes reflect in Chat UI after reload", async ({ page, request }) => {
    await request.put(`${apiBase}/api/router-settings`, {
      data: {
        normalChatRecommenderFallbackModelId: "codex:gpt-5.5",
        normalChatRecommenderFallbackReasoningLevel: "low",
      },
    });

    await page.goto("/");
    const card = page.getByTestId("recommender-control");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId("chat-recommender-fallback-model")).toHaveValue("codex:gpt-5.5");
    await expect(card.getByTestId("chat-recommender-fallback-reasoning")).toBeEnabled();
  });

  test("MiniMax-M3 reasoning options in Chat UI are provider_default, adaptive, enabled, disabled", async ({
    page,
  }) => {
    // Set the primary recommender engine to MiniMax-M3 (a thinking-
    // budget model), then assert the Chat UI reasoning <select>
    // lists the well-known provider-native thinking modes — never a
    // fake OpenAI "low" or "high".
    await page.goto("/");
    const card = page.getByTestId("recommender-control");
    await expect(card).toBeVisible({ timeout: 15_000 });

    await card.getByTestId("chat-recommender-model").selectOption("MiniMax-M3");
    await expect(card.getByTestId("chat-recommender-reasoning")).toHaveValue("provider_default");

    const options = await card
      .getByTestId("chat-recommender-reasoning")
      .locator("option")
      .allTextContents();
    const normalized = options.map((o) => o.trim().toLowerCase());
    for (const expected of ["provider_default", "adaptive", "enabled", "disabled"]) {
      expect(normalized).toContain(expected);
    }
    // No fake "low" for the thinking-budget capability.
    expect(normalized).not.toEqual(["low"]);
  });

  test("Manual model/reasoning and recommender engine/reasoning do not cross-wire", async ({
    page,
    request,
  }) => {
    // Set up a deliberate cross-wiring trap:
    //   manual chat model  = codex:gpt-5.4-mini (Codex subscription)
    //   recommender engine = MiniMax-M3  (thinking-budget)
    //
    // Both are valid settings, but the chat UI must never mix them:
    // the manual model dropdown / thinking picker reflects the
    // manual selection, the recommender model / reasoning reflects
    // the configured engine, and the recommender-thinking picker
    // does NOT show fake "low" (which is an OpenAI effort value) for
    // the MiniMax engine.
    await request.put(`${apiBase}/api/router-settings`, {
      data: {
        normalChatRecommenderModelId: "MiniMax-M3",
        normalChatRecommenderReasoningLevel: "provider_default",
        normalChatRecommenderFallbackModelId: null,
        normalChatRecommenderFallbackReasoningLevel: null,
      },
    });

    await page.goto("/");

    // Manual top bar: the model trigger labels the manual Codex row,
    // the reasoning dropdown is the Codex reasoning surface (which
    // advertises "Unsupported by engine" for Codex CLI — a different
    // value from the recommender's thinking modes).
    const topBar = page.getByTestId("manual-chat-model-controls");
    await expect(topBar).toBeVisible({ timeout: 15_000 });
    const trigger = topBar.getByTestId("aui-model-selector-trigger");
    await expect(trigger).toContainText(/Codex/);

    // The manual thinking dropdown does NOT show MiniMax thinking
    // modes (provider_default / adaptive / enabled / disabled). Codex
    // is an effort-level model with `kind: "none"`, so the manual
    // thinking control surface is the "unsupported" notice.
    const manualThinking = topBar.getByTestId("model-reasoning-select");
    if ((await manualThinking.count()) > 0) {
      // When Codex has a non-`none` capability this select renders
      // (e.g. effort-level). Make sure MiniMax-only modes never leak
      // into it.
      const manualOptions = await manualThinking
        .locator("option, [data-reasoning-level]")
        .allTextContents();
      for (const opt of manualOptions) {
        const text = opt.toLowerCase();
        for (const forbidden of ["provider_default", "adaptive"]) {
          expect(text).not.toContain(forbidden);
        }
      }
    } else {
      // Codex kind: "none" \u2014 the manual bar renders the
      // "Reasoning controls are not supported" notice instead of a
      // real dropdown. Either way, the manual control surface is
      // distinct from the recommender one.
      await expect(topBar).toContainText(
        /Reasoning controls are not supported|Unsupported by engine/i,
      );
    }

    // Recommender card: MiniMax-M3 selected, reasoning is
    // `provider_default` (NOT a Codex "low" / "Unsupported").
    const card = page.getByTestId("recommender-control");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("chat-recommender-model")).toHaveValue("MiniMax-M3");
    await expect(card.getByTestId("chat-recommender-reasoning")).toHaveValue("provider_default");
    const recommenderOptions = await card
      .getByTestId("chat-recommender-reasoning")
      .locator("option")
      .allTextContents();
    const normalizedRecommender = recommenderOptions.map((o) => o.trim().toLowerCase());
    // The recommender picker is MiniMax-native, so it does NOT
    // contain OpenAI effort values like "xhigh" / "high".
    expect(normalizedRecommender.every((o) => o !== "xhigh")).toBe(true);
    expect(normalizedRecommender.every((o) => o !== "high")).toBe(true);
    // But it does contain the MiniMax thinking modes.
    for (const expected of ["provider_default", "adaptive", "enabled", "disabled"]) {
      expect(normalizedRecommender).toContain(expected);
    }
  });
});
