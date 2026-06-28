import { expect, test, type Page, type Request } from "@playwright/test";

/**
 * E2E coverage for the recommender model allowlist + reasoning-level
 * picker + chat composer inline recommender control. Regression specs
 * for the work that turned the Settings page recommender section into a
 * real configuration surface (allowlist + reasoning level) and moved the
 * chat composer control into a unified `RecommenderControl`.
 *
 * What these tests cover (mapped to spec names below):
 *   1. The recommender model picker on /settings/router renders the same
 *      shape as before and persists across reload (regression on the
 *      `router-settings-normal-chat-recommender-model` test id).
 *   2. The new recommender reasoning-level `<select>` is visible under
 *      the picker and persists on Save.
 *   3. The new "Models the recommender can recommend" subsection shows
 *      the live summary, and `Allow all enabled` / `Block all` flip it.
 *   4. Per-row Recommender switches in the Model Registry toggle
 *      individual model ids into / out of the allowlist and persist.
 *   5. Codex subscription rows render an ACTIVE Recommender Switch
 *      (no `🔒 Disabled` lock badge) — the recommender now treats Codex
 *      as a valid chat provider, mirroring the chat picker.
 *   6. The chat composer `RecommenderControl` renders a model picker +
 *      reasoning dropdown next to the on/off toggle.
 *   7. Changing the chat-composer reasoning dropdown PATCHes
 *      /api/router/settings and the value round-trips on reload.
 *
 * Test-id reference (single source of truth):
 *   - Chat composer:
 *       recommender-control            (wrapper)
 *       recommender-toggle             (on/off toggle)
 *       chat-recommender-model         (model picker trigger)
 *       chat-recommender-reasoning     (reasoning `<select>`)
 *       chat-recommender-model-saving  (saving indicator)
 *   - Settings page:
 *       router-settings-normal-chat-recommender-model
 *                                      (hidden native <select> backing the picker)
 *       router-settings-normal-chat-recommender-reasoning
 *                                      (reasoning <select>)
 *       router-settings-recommender-allowlist       (subsection panel)
 *       router-settings-recommender-allowlist-summary (live summary)
 *       router-settings-recommender-allowlist-allow-all
 *       router-settings-recommender-allowlist-block-all
 *       registry-recommender-toggle-{modelId}       (per-row Switch)
 *       registry-recommender-locked-{modelId}        (per-row lock badge)
 *
 * Environment: this suite relies on the Playwright config's
 * `CONTROL_ROOM_FAKE_LLM=1` + `CONTROL_ROOM_FAKE_OPENAI_MODELS=1` so the
 * registry contains deterministic Codex + OpenAI + MiniMax rows.
 */

async function gotoSettings(page: Page) {
  await page.goto("/settings/router");
  await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
    timeout: 15_000,
  });
}

async function gotoChat(page: Page) {
  await page.goto("/");
  await expect(page.getByText("How can I help you today?")).toBeVisible({ timeout: 15_000 });
}

async function fetchSettings(page: Page): Promise<{
  normalChatRecommenderModelId: string | null;
  normalChatRecommenderReasoningLevel: string | null;
  normalChatRecommenderAllowedModels: string[] | null;
}> {
  const r = await page.request.get("/api/router-settings");
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  return {
    normalChatRecommenderModelId: body.effective?.normalChatRecommenderModelId ?? null,
    normalChatRecommenderReasoningLevel:
      body.effective?.normalChatRecommenderReasoningLevel ?? null,
    normalChatRecommenderAllowedModels: body.effective?.normalChatRecommenderAllowedModels ?? null,
  };
}

// ---------------------------------------------------------------------------
// Settings page: recommender reasoning-level dropdown
// ---------------------------------------------------------------------------

test("settings UI exposes a reasoning-effort dropdown for the recommender model", async ({
  page,
}) => {
  await gotoSettings(page);

  // Default: low.
  const select = page.getByTestId("router-settings-normal-chat-recommender-reasoning");
  await expect(select).toBeVisible();
  await expect(select).toHaveValue("low");

  // Bump to "high" — Save must enable and round-trip.
  await select.selectOption("high");
  const saveBtn = page.getByTestId("router-settings-save");
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();
  await expect(page.getByTestId("router-settings-save-status")).toBeVisible({ timeout: 5_000 });

  // Persists on reload.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("router-settings-normal-chat-recommender-reasoning")).toHaveValue(
    "high",
  );

  // Reset to "low" so we don't leak state into other specs.
  await page.getByTestId("router-settings-normal-chat-recommender-reasoning").selectOption("low");
  await page.getByTestId("router-settings-save").click();
  await page.waitForTimeout(500);
});

// ---------------------------------------------------------------------------
// Settings page: recommender allowlist subsection + bulk actions
// ---------------------------------------------------------------------------

test("settings UI shows the recommender allowlist summary + bulk-action buttons", async ({
  page,
}) => {
  await gotoSettings(page);

  const panel = page.getByTestId("router-settings-recommender-allowlist");
  await expect(panel).toBeVisible();

  // Default: no restriction (`null`) → summary mentions "All enabled models".
  const summary = page.getByTestId("router-settings-recommender-allowlist-summary");
  await expect(summary).toContainText(/All enabled models/i);

  await expect(page.getByTestId("router-settings-recommender-allowlist-allow-all")).toBeVisible();
  await expect(page.getByTestId("router-settings-recommender-allowlist-block-all")).toBeVisible();

  // Block all → summary flips to "No models are currently allowed".
  await page.getByTestId("router-settings-recommender-allowlist-block-all").click();
  await expect(summary).toContainText(/No models are currently allowed/i);
  const saveBtn = page.getByTestId("router-settings-save");
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();
  await expect(page.getByTestId("router-settings-save-status")).toBeVisible({ timeout: 5_000 });

  // Allow all enabled → summary flips back to "All enabled models" and the
  // persisted value reverts to `null` (the snap-back optimization).
  await page.getByTestId("router-settings-recommender-allowlist-allow-all").click();
  await expect(summary).toContainText(/All enabled models/i);
  await saveBtn.click();
  await page.waitForTimeout(500);

  const after = await fetchSettings(page);
  expect(after.normalChatRecommenderAllowedModels).toBeNull();
});

// ---------------------------------------------------------------------------
// Settings page: per-row Recommender switches in the Model Registry
// ---------------------------------------------------------------------------

test("registry rows expose a Recommender toggle and toggling persists the allowlist", async ({
  page,
}) => {
  await gotoSettings(page);

  // Codex rows are eligible chat models — they must render an ACTIVE
  // Recommender Switch, not a `🔒 Disabled` lock badge. (Regression
  // on the user-reported "Codex models should be selectable" change.)
  const codexSwitch = page.getByTestId("registry-recommender-toggle-codex:gpt-5.4-mini");
  await expect(codexSwitch).toBeVisible();
  await expect(codexSwitch).toHaveAttribute("data-state", "checked");

  // Uncheck it via the registry row → summary reflects "X of N enabled
  // models may be recommended" (N depends on the registry in fake mode,
  // but it must be a finite integer, not "No models …").
  const summary = page.getByTestId("router-settings-recommender-allowlist-summary");
  await codexSwitch.click();
  await expect(summary).toContainText(/of \d+ enabled models may be recommended/);

  await page.getByTestId("router-settings-save").click();
  await expect(page.getByTestId("router-settings-save-status")).toBeVisible({ timeout: 5_000 });

  // Persisted value is the explicit list with `codex:gpt-5.4-mini` excluded.
  const persisted = await fetchSettings(page);
  expect(persisted.normalChatRecommenderAllowedModels).not.toBeNull();
  expect(persisted.normalChatRecommenderAllowedModels).not.toContain("codex:gpt-5.4-mini");
  // It must still allow other enabled models (Codex / MiniMax / OpenAI).
  expect(persisted.normalChatRecommenderAllowedModels!.length).toBeGreaterThan(0);

  // Reset to default so we don't leak state into other specs.
  await page.getByTestId("router-settings-recommender-allowlist-allow-all").click();
  await page.getByTestId("router-settings-save").click();
  await page.waitForTimeout(500);
});

// ---------------------------------------------------------------------------
// Settings page: Codex rows render an ACTIVE Recommender Switch (no lock)
// ---------------------------------------------------------------------------

test("registry Codex rows render an active Recommender Switch (no lock badge)", async ({
  page,
}) => {
  await gotoSettings(page);

  // Codex is in the registry as `codex:*` rows. None of them should be
  // locked out of the recommender allowlist — the recommender picks
  // from the chat picker, and Codex is a valid chat picker entry.
  for (const id of [
    "codex:gpt-5.5",
    "codex:gpt-5.4",
    "codex:gpt-5.4-mini",
    "codex:gpt-5.3-codex-spark",
  ]) {
    const sw = page.getByTestId(`registry-recommender-toggle-${id}`);
    await expect(sw, `codex row ${id} should have an active Recommender switch`).toBeVisible();
  }
});

// ---------------------------------------------------------------------------
// Chat composer: RecommenderControl renders the reasoning dropdown
// ---------------------------------------------------------------------------

test("chat composer exposes the recommender model picker + reasoning dropdown", async ({
  page,
}) => {
  await gotoChat(page);

  const control = page.getByTestId("recommender-control");
  await expect(control).toBeVisible();

  const picker = page.getByTestId("chat-recommender-model");
  await expect(picker).toBeVisible();

  const reasoning = page.getByTestId("chat-recommender-reasoning");
  await expect(reasoning).toBeVisible();
  // Default = low (matches settings default).
  await expect(reasoning).toHaveValue("low");
});

test("changing the chat-composer reasoning dropdown PATCHes the server and persists", async ({
  page,
}) => {
  await gotoChat(page);

  // Capture the PATCH so we can assert what the chat composer sends.
  const patches: Array<{ body: string }> = [];
  page.on("request", (req: Request) => {
    if (req.method() === "PATCH" && req.url().endsWith("/api/router/settings")) {
      patches.push({ body: req.postData() ?? "" });
    }
  });

  const reasoning = page.getByTestId("chat-recommender-reasoning");
  await reasoning.selectOption("medium");
  // Give the optimistic update + PATCH a tick to fire.
  await page.waitForTimeout(800);

  expect(patches.length, "chat composer should PATCH the reasoning level").toBeGreaterThan(0);
  expect(patches[patches.length - 1].body).toContain(
    '"normalChatRecommenderReasoningLevel":"medium"',
  );

  // Server confirms.
  const after = await fetchSettings(page);
  expect(after.normalChatRecommenderReasoningLevel).toBe("medium");

  // Reload → dropdown still says medium (round-tripped through the server).
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("chat-recommender-reasoning")).toHaveValue("medium");

  // Reset to low so we don't leak state into other specs.
  await page.getByTestId("chat-recommender-reasoning").selectOption("low");
  await page.waitForTimeout(800);
  const afterReset = await fetchSettings(page);
  expect(afterReset.normalChatRecommenderReasoningLevel).toBe("low");
});

// ---------------------------------------------------------------------------
// /api/model/recommend: Codex-eligibility contract (lightweight smoke)
// ---------------------------------------------------------------------------

test("/api/model/recommend honors the user-curated allowlist and reports the right diagnostics", async ({
  request,
}) => {
  // Block-all → recommender has no models to recommend and returns a
  // fallback with the user-actionable diagnostics message.
  const save = await request.patch("/api/router/settings", {
    data: { normalChatRecommenderAllowedModels: [] },
  });
  expect(save.ok()).toBeTruthy();

  const rec = await request.post("/api/model/recommend", {
    data: {
      threadId: null,
      projectId: null,
      message: "help me refactor a Postgres function",
      currentModelId: "codex:gpt-5.4-mini",
      currentProvider: "codex",
      currentReasoningLevel: "low",
      mode: "normal_chat",
    },
  });
  expect(rec.ok()).toBeTruthy();
  const body = await rec.json();
  expect(body.diagnostics?.fallback).toBe(true);
  expect(body.diagnostics?.recommenderResolutionReason ?? "").toMatch(
    /No models are enabled for the recommender/,
  );

  // Reset back to default (`null`) so we don't leak state.
  await request.patch("/api/router/settings", {
    data: { normalChatRecommenderAllowedModels: null },
  });
});
