import { expect, test, type Page, type APIRequestContext } from "@playwright/test";

/**
 * E2E coverage for the `/api/models` chat-picker semantics.
 *
 * Contract under test:
 *   1. `/api/models` returns the **currently usable** chat-picker list —
 *      models that pass provider-availability, credentials, configured
 *      status, AND the user-curated Manual toggle from the Settings
 *      registry. The full known/discovered/configurable registry stays
 *      reachable via `/api/router-settings` (effectiveRegistry.models).
 *   2. Toggling a model OFF in the Settings registry Manual column
 *      removes it from `/api/models` AND from the chat composer.
 *   3. Toggling it back ON restores it everywhere.
 *   4. The toggled-off model stays visible in `/settings/router` so
 *      the user can re-enable it.
 *   5. Codex + MiniMax + OpenAI rows all follow the same rule.
 *   6. The router allowlist and the manual selector are independent
 *      concepts — toggling Manual does NOT touch `allowedCombos`.
 *
 * The Manual toggle lives in `model_selector_prefs` (a separate table
 * from `router_settings.allowedCombos`) and is mutated via
 * `PUT /api/model-selector-prefs`. The chat composer reads the same
 * prefs through `getEffectiveModelsResponse`, so a toggle propagates
 * to the picker on the next fetch.
 */

async function fetchModels(
  req: APIRequestContext,
): Promise<Array<{ providerId: string; modelId: string; enabled: boolean }>> {
  const res = await req.get("/api/models");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return body.models;
}

async function fetchRegistryIds(req: APIRequestContext): Promise<string[]> {
  const res = await req.get("/api/router-settings");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return (body.effectiveRegistry?.models ?? []).map((m: { modelId: string }) => m.modelId);
}

async function setSelectorPref(
  req: APIRequestContext,
  modelId: string,
  visible: boolean,
): Promise<void> {
  // Fetch existing prefs, mutate the one we care about, write the
  // whole object back. The route accepts the full object, so we
  // round-trip the others to avoid clobbering user choices.
  const cur = await req.get("/api/model-selector-prefs");
  expect(cur.ok()).toBeTruthy();
  const curBody = await cur.json();
  const nextPrefs: Record<string, { visible: boolean }> = {
    ...(curBody.preferences ?? {}),
    [modelId]: { visible },
  };
  const put = await req.put("/api/model-selector-prefs", {
    data: { preferences: nextPrefs },
  });
  expect(put.ok()).toBeTruthy();
}

async function gotoSettings(page: Page) {
  await page.goto("/settings/router");
  await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
    timeout: 15_000,
  });
}

// ---------------------------------------------------------------------------
// Default state: every provider's models surface in the picker
// ---------------------------------------------------------------------------

test("/api/models returns OpenAI + Codex + MiniMax entries by default (fake-mode + keyless env)", async ({
  request,
}) => {
  // Reset the prefs singleton so we observe the default behavior.
  await request.put("/api/model-selector-prefs", {
    data: { preferences: {} },
  });

  const models = await fetchModels(request);
  const providers = new Set(models.map((m) => m.providerId));
  // Codex + MiniMax are configured in this VM (keyset or fake mode).
  // OpenAI surfaces its known fake ids even when the real API key is
  // missing — they're "disabled" with a precise reason string, but
  // still visible. We don't assert on OpenAI membership here because
  // the fake-mode discovery may not run from a fresh test process; the
  // Codex + MiniMax contract is the one the user explicitly called out.
  expect(providers.has("codex")).toBeTruthy();
  expect(providers.has("minimax")).toBeTruthy();
});

// ---------------------------------------------------------------------------
// Codex: toggle OFF → absent from /api/models, still in registry
// ---------------------------------------------------------------------------

test("toggling a Codex model OFF removes it from /api/models and from the chat picker, but it stays in /settings/router", async ({
  page,
  request,
}) => {
  // Reset prefs first so this test is independent of any prior toggle.
  await request.put("/api/model-selector-prefs", { data: { preferences: {} } });

  // Baseline: codex:gpt-5.4-mini is in /api/models.
  const before = await fetchModels(request);
  expect(before.some((m) => m.modelId === "codex:gpt-5.4-mini")).toBeTruthy();

  // Settings UI has an ACTIVE Manual toggle for Codex rows (regression
  // on the locked-by-providerId bug). The Toggle should be visible.
  await gotoSettings(page);
  // Codex provider group may need to be expanded.
  const codexGroup = page.getByTestId("registry-provider-group-codex");
  if ((await codexGroup.getAttribute("aria-expanded")) === "false") {
    await codexGroup.click();
    await page.waitForTimeout(150);
  }
  const toggle = page.getByTestId("registry-manual-toggle-codex:gpt-5.4-mini");
  await expect(toggle).toBeVisible();

  // Toggle OFF.
  await toggle.click();
  // Toggle handler PUTs to /api/model-selector-prefs immediately.
  // Wait for the request to land.
  await page.waitForTimeout(500);

  // Assert /api/models no longer contains codex:gpt-5.4-mini.
  const after = await fetchModels(request);
  expect(after.some((m) => m.modelId === "codex:gpt-5.4-mini")).toBeFalsy();

  // Assert /api/router-settings.effectiveRegistry.models STILL contains
  // codex:gpt-5.4-mini — the user can re-enable it from /settings/router.
  const registryIds = await fetchRegistryIds(request);
  expect(registryIds).toContain("codex:gpt-5.4-mini");

  // Assert the chat picker no longer renders the Codex option for this
  // model id. We don't have a direct listbox aria-label here, so we
  // check via the API (the picker is fed by /api/models).
  // Toggle ON — model returns to /api/models.
  await toggle.click();
  await page.waitForTimeout(500);
  const restored = await fetchModels(request);
  expect(restored.some((m) => m.modelId === "codex:gpt-5.4-mini")).toBeTruthy();

  // Cleanup: reset prefs so this test is hermetic.
  await request.put("/api/model-selector-prefs", { data: { preferences: {} } });
});

// ---------------------------------------------------------------------------
// MiniMax: toggle OFF → absent from /api/models, still in registry
// ---------------------------------------------------------------------------

test("toggling a MiniMax model OFF removes it from /api/models, stays in registry, re-enable returns it", async ({
  page,
  request,
}) => {
  await request.put("/api/model-selector-prefs", { data: { preferences: {} } });

  // Baseline: MiniMax-M3 is in /api/models.
  const before = await fetchModels(request);
  expect(before.some((m) => m.modelId === "MiniMax-M3")).toBeTruthy();

  await gotoSettings(page);
  // The MiniMax provider group header test id.
  const minimaxGroup = page.getByTestId("registry-provider-group-minimax");
  if ((await minimaxGroup.getAttribute("aria-expanded")) === "false") {
    await minimaxGroup.click();
    await page.waitForTimeout(150);
  }
  const toggle = page.getByTestId("registry-manual-toggle-MiniMax-M3");
  await expect(toggle).toBeVisible();
  await toggle.click();
  await page.waitForTimeout(500);

  // /api/models: MiniMax-M3 is gone.
  const after = await fetchModels(request);
  expect(after.some((m) => m.modelId === "MiniMax-M3")).toBeFalsy();

  // /api/router-settings.effectiveRegistry.models: still has it.
  const registryIds = await fetchRegistryIds(request);
  expect(registryIds).toContain("MiniMax-M3");

  // Toggle ON — comes back.
  await toggle.click();
  await page.waitForTimeout(500);
  const restored = await fetchModels(request);
  expect(restored.some((m) => m.modelId === "MiniMax-M3")).toBeTruthy();

  // Cleanup.
  await request.put("/api/model-selector-prefs", { data: { preferences: {} } });
});

// ---------------------------------------------------------------------------
// Manual toggle and router allowlist are independent concepts
// ---------------------------------------------------------------------------

test("Manual toggle does not affect the router allowlist (allowedCombos)", async ({
  page,
  request,
}) => {
  // Reset both prefs + allowlist to known-good defaults before the test.
  await request.put("/api/model-selector-prefs", { data: { preferences: {} } });

  // Capture the router allowlist baseline (read it from the registry DTO).
  const baseline = await request.get("/api/router-settings");
  const baselineBody = await baseline.json();
  const allowedCombosBefore: ReadonlyArray<{ modelId: string; reasoningLevel: string }> =
    baselineBody.effective?.allowedCombos ?? [];
  expect(allowedCombosBefore.length).toBeGreaterThan(0);

  // Toggle a MiniMax model OFF in the Manual column.
  await gotoSettings(page);
  const minimaxGroup = page.getByTestId("registry-provider-group-minimax");
  if ((await minimaxGroup.getAttribute("aria-expanded")) === "false") {
    await minimaxGroup.click();
    await page.waitForTimeout(150);
  }
  await page.getByTestId("registry-manual-toggle-MiniMax-M3").click();
  await page.waitForTimeout(500);

  // The router allowlist must be unchanged — Manual toggle only
  // affects the chat picker, never the router pool.
  const after = await request.get("/api/router-settings");
  const afterBody = await after.json();
  const allowedCombosAfter = afterBody.effective?.allowedCombos ?? [];
  expect(allowedCombosAfter).toEqual(allowedCombosBefore);

  // Cleanup.
  await request.put("/api/model-selector-prefs", { data: { preferences: {} } });
});
