import { expect, test, type Page } from "@playwright/test";

/**
 * Focused regression suite for the chat UI top controls layout.
 *
 * The brief: combine the manual chat model controls into one compact
 * top bar (model selector + thinking selector + access label + Router
 * A/B pill + theme button). The chat UI must NOT render any
 * router/recommender engine configuration controls — those live in
 * Settings → Router → Tab B. The chat composer keeps a compact
 * "Recommend on/off" pill; nothing else.
 *
 * Each test maps to a brief requirement verbatim so the next refactor
 * has a clear list of contracts to keep intact:
 *
 *   1. Chat UI no longer renders a separate large "Manual chat model"
 *      row/card below the top bar.
 *   2. Top bar renders: manual model selector, manual thinking
 *      selector, access label, Router A/B pill.
 *   3. Chat UI does NOT render any recommender engine / fallback
 *      engine editing controls (no model picker, no reasoning
 *      selector, no "Recommend engine" row, no "Fallback engine"
 *      row).
 *   4. Chat composer renders a compact "Recommend on/off" pill
 *      (the same `RecommenderToggle` that lives in the composer
 *      toolbar).
 *   5. The chat "Recommend on/off" pill toggles the per-tab
 *      sessionStorage flag and survives a reload.
 *
 * Test ID reference (single source of truth):
 *   - Top bar:
 *       manual-chat-model-controls      (the bar)
 *       aui-model-selector-trigger      (model trigger)
 *       chat-model-access-label         (access label)
 *       model-reasoning-select          (manual thinking dropdown)
 *       router-ab-toggle / router-ab-openai-only-pill
 *   - Composer:
 *       recommender-toggle              (compact on/off pill in
 *                                        the composer toolbar)
 *
 * Notably ABSENT (intentionally) from the chat UI:
 *   - recommender-control             (the card)
 *   - recommender-toggle-well         (the on/off well)
 *   - chat-recommender-engine-controls   (primary row)
 *   - chat-recommender-model
 *   - chat-recommender-reasoning
 *   - chat-recommender-fallback-controls (fallback row)
 *   - chat-recommender-fallback-model
 *   - chat-recommender-fallback-reasoning
 *   - chat-recommender-model-saving
 *   - chat-recommender-model-error
 *
 * These test IDs are reserved for the chat surface but must not
 * appear there. They live in Settings → Router → Tab B
 * (`router-settings-normal-chat-recommender-model`,
 *  `router-settings-normal-chat-recommender-reasoning`,
 *  `router-settings-normal-chat-recommender-fallback-model`,
 *  `router-settings-normal-chat-recommender-fallback-reasoning`).
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

  test("Chat UI does NOT render recommender engine / fallback engine editing controls", async ({
    page,
  }) => {
    // The chat surface is the manual-execution-model surface only.
    // Router/recommender engine + fallback engine editing lives in
    // Settings → Router → Tab B. None of the chat-side editing
    // controls must appear above, below, or beside the conversation.
    await page.goto("/");
    await expect(page.getByTestId("manual-chat-model-controls")).toBeVisible({ timeout: 15_000 });

    // No chat-side recommender/fallback card or rows.
    await expect(page.getByTestId("recommender-control")).toHaveCount(0);
    await expect(page.getByTestId("chat-recommender-engine-controls")).toHaveCount(0);
    await expect(page.getByTestId("chat-recommender-fallback-controls")).toHaveCount(0);
    // No chat-side model / reasoning selectors.
    await expect(page.getByTestId("chat-recommender-model")).toHaveCount(0);
    await expect(page.getByTestId("chat-recommender-reasoning")).toHaveCount(0);
    await expect(page.getByTestId("chat-recommender-fallback-model")).toHaveCount(0);
    await expect(page.getByTestId("chat-recommender-fallback-reasoning")).toHaveCount(0);
    // No chat-side saving / error surfaces tied to the removed card.
    await expect(page.getByTestId("chat-recommender-model-saving")).toHaveCount(0);
    await expect(page.getByTestId("chat-recommender-model-error")).toHaveCount(0);
  });

  test("Chat composer renders a compact 'Recommend on/off' pill", async ({ page }) => {
    // The composer toolbar keeps the small on/off pill; nothing else
    // from the old inline config card.
    await page.goto("/");
    const toggle = page.getByTestId("recommender-toggle");
    await expect(toggle).toBeVisible({ timeout: 15_000 });
    // The toggle is a compact pill, not a large card.
    await expect(toggle).toContainText(/Recommend (on|off)/);
  });

  test("Chat composer's 'Recommend on/off' pill persists via sessionStorage and survives reload", async ({
    page,
  }) => {
    await page.goto("/");
    const toggle = page.getByTestId("recommender-toggle");
    await expect(toggle).toBeVisible({ timeout: 15_000 });

    // Default = off; pill label says "off" and aria-pressed=false.
    const initialPressed = await toggle.getAttribute("aria-pressed");
    if (initialPressed === "true") {
      // Pre-seeded state from a previous spec — turn it off first.
      await toggle.click();
    }
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(toggle).toContainText(/Recommend off/);

    // Click on.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(toggle).toContainText(/Recommend on/);

    // Reload — the sessionStorage flag survives a hard refresh so
    // the next session picks up the user's pick.
    await page.reload({ waitUntil: "domcontentloaded" });
    const reloadedToggle = page.getByTestId("recommender-toggle");
    await expect(reloadedToggle).toBeVisible({ timeout: 15_000 });
    await expect(reloadedToggle).toHaveAttribute("aria-pressed", "true");
    await expect(reloadedToggle).toContainText(/Recommend on/);

    // Toggle off so we don't leak state into other specs.
    await reloadedToggle.click();
    await expect(reloadedToggle).toHaveAttribute("aria-pressed", "false");
  });

  test("Settings Tab B still owns the recommender engine + fallback engine controls", async ({
    page,
    request,
  }) => {
    // Sanity: the canonical editing surface (Settings → Router → Tab B)
    // is unaffected. The chat-side removal MUST NOT regress the
    // Settings page.
    await gotoSettings(page);
    await expect(page.getByTestId("router-settings-normal-chat-recommender-model")).toBeVisible();
    await expect(
      page.getByTestId("router-settings-normal-chat-recommender-reasoning"),
    ).toBeVisible();
    await expect(
      page.getByTestId("router-settings-normal-chat-recommender-fallback-model"),
    ).toBeVisible();
    await expect(
      page.getByTestId("router-settings-normal-chat-recommender-fallback-reasoning"),
    ).toBeVisible();

    // Round-trip a fallback change end-to-end (Settings is the
    // canonical writer).
    await page
      .getByTestId("router-settings-normal-chat-recommender-fallback-model")
      .selectOption("codex:gpt-5.5");
    await page
      .getByTestId("router-settings-normal-chat-recommender-fallback-reasoning")
      .selectOption("low");
    await page.getByTestId("router-settings-save").click();
    await expect(page.getByTestId("router-settings-save-status")).toBeVisible({ timeout: 5_000 });

    const after = await request.get(`${apiBase}/api/router-settings`).then((r) => r.json());
    expect(after.effective.normalChatRecommenderFallbackModelId).toBe("codex:gpt-5.5");
    expect(after.effective.normalChatRecommenderFallbackReasoningLevel).toBe("low");
  });
});
