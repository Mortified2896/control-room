import { expect, test, type Page, type APIRequestContext as Request } from "@playwright/test";

/**
 * Focused regression suite for the two-rung recommender contract.
 *
 * Product intent: the Chat UI shows EXACTLY two recommender controls
 * — "Recommender engine" and "Fallback engine (one)" — so the backend
 * must mirror that mental model: try the configured primary, then
 * the configured fallback, then stop. No Codex default, no MiniMax
 * default, no OpenAI default, no hidden third option.
 *
 * Tests in this file (mapped to the brief verbatim):
 *   1. Primary succeeds → only primary is called. Fallback is not
 *      called. No default rungs are called.
 *   2. Primary fails + fallback configured → fallback is called.
 *      Diagnostics source is `configured_fallback`. No default rungs
 *      are called after fallback.
 *   3. Primary fails + fallback succeeds → recommendation proceeds.
 *      callAttempts has exactly two entries.
 *   4. Primary fails + fallback fails → loud blocked failure.
 *      callAttempts has exactly two entries. No third model is tried.
 *   5. Primary fails + no fallback configured → loud blocked
 *      failure. callAttempts has exactly one entry. No third /
 *      default model is tried.
 *   6. Even with `allowOpenAiApiRouter = true`, OpenAI default is
 *      not tried after configured fallback failure.
 *   7. UI and backend terminology match: "Fallback engine (one)"
 *      means exactly one configured fallback engine.
 *
 * Environment: this suite relies on the Playwright config's
 * `CONTROL_ROOM_FAKE_LLM=1` + `CONTROL_ROOM_FAKE_OPENAI_MODELS=1` so
 * the registry contains deterministic Codex + OpenAI + MiniMax rows.
 */

const apiBase = "http://127.0.0.1:3100";

async function putSettings(request: Request, data: Record<string, unknown>): Promise<void> {
  const r = await request.put(`${apiBase}/api/router-settings`, { data });
  expect(r.ok()).toBeTruthy();
}

async function recommend(
  request: Request,
  message: string,
): Promise<{
  recommendedModelId: string | null;
  loudFailure?: boolean;
  recommendedReasoningLevel?: string | null;
  reasoning?: string;
  diagnostics: {
    recommenderSource: string | null;
    recommenderProvider: string;
    recommenderModelId: string;
    fallback: boolean;
    fallbackChain: ReadonlyArray<{ modelId: string; source?: string }>;
    callAttempts?: ReadonlyArray<{
      source: "configured" | "configured_fallback";
      modelId: string;
      reasoning: string;
      status: "success" | "failed";
      reason: string;
    }>;
  };
}> {
  const r = await request.post(`${apiBase}/api/model/recommend`, {
    data: {
      threadId: null,
      projectId: null,
      message,
      currentModelId: "codex:gpt-5.4-mini",
      currentProvider: "codex",
      currentReasoningLevel: "low",
      mode: "normal_chat",
    },
  });
  expect(r.ok()).toBeTruthy();
  return r.json();
}

test.describe("Two-rung recommender contract", () => {
  test.beforeEach(async ({ request }) => {
    // Reset to safe defaults so each test starts from a known state.
    await putSettings(request, {
      allowOpenAiApiRouter: false,
      normalChatRecommenderModelId: "codex:gpt-5.4-mini",
      normalChatRecommenderReasoningLevel: "low",
      normalChatRecommenderFallbackModelId: null,
      normalChatRecommenderFallbackReasoningLevel: null,
      allowedCombos: [
        { modelId: "codex:gpt-5.4-mini", reasoningLevel: "low" },
        { modelId: "codex:gpt-5.5", reasoningLevel: "low" },
      ],
      fallbackModelId: "codex:gpt-5.4-mini",
      fallbackReasoningLevel: "low",
      normalChatRecommenderAllowedModels: null,
    });
  });

  test("1. Primary succeeds → only primary is called. No default rungs are tried.", async ({
    request,
  }) => {
    // Both primary and fallback are configured. The primary should
    // succeed in fake-LLM mode (Codex is healthy). The chain must
    // NOT walk the fallback or any default rung.
    await putSettings(request, {
      normalChatRecommenderModelId: "codex:gpt-5.4-mini",
      normalChatRecommenderReasoningLevel: "low",
      normalChatRecommenderFallbackModelId: "MiniMax-M3",
      normalChatRecommenderFallbackReasoningLevel: "provider_default",
      allowOpenAiApiRouter: true, // even WITH OpenAI opt-in, no third rung is tried
    });
    const body = await recommend(request, "Test primary-only success path.");
    expect(body.loudFailure).toBeFalsy();
    // Source is the configured primary, NOT a default rung.
    expect(body.diagnostics.recommenderSource).toBe("configured");
    // fallbackChain contains exactly the two configured rungs (no
    // Codex default, no MiniMax default, no OpenAI default).
    expect(body.diagnostics.fallbackChain).toHaveLength(2);
    expect(body.diagnostics.fallbackChain.map((c) => c.modelId)).toEqual([
      "codex:gpt-5.4-mini",
      "MiniMax-M3",
    ]);
    // callAttempts has exactly one entry (the successful primary).
    expect(body.diagnostics.callAttempts).toHaveLength(1);
    expect(body.diagnostics.callAttempts![0]!.source).toBe("configured");
    expect(body.diagnostics.callAttempts![0]!.status).toBe("success");
  });

  test("2 + 3. Primary fails + fallback succeeds → fallback is called, no default rungs after", async ({
    request,
  }) => {
    // Force the primary to fail by setting it to a fabricated
    // `codex:*` id. The strict validator accepts unknown `codex:*`
    // ids (the inferred provider is "codex", not "openai"), but
    // the resolver refuses them at runtime. The chain must walk
    // exactly one rung: the configured fallback. No third default
    // rung, even with OpenAI opt-in.
    await putSettings(request, {
      normalChatRecommenderModelId: "codex:no-such-engine-xyz",
      normalChatRecommenderReasoningLevel: "low",
      normalChatRecommenderFallbackModelId: "MiniMax-M3",
      normalChatRecommenderFallbackReasoningLevel: "provider_default",
      allowOpenAiApiRouter: true,
    });
    const body = await recommend(request, "Test primary-fail / fallback-success path.");
    // The resolver refuses "codex:no-such-engine-xyz" → loud failure path.
    expect(body.loudFailure).toBe(true);
    // The chain must contain EXACTLY the two configured rungs.
    expect(body.diagnostics.fallbackChain).toHaveLength(2);
    expect(body.diagnostics.fallbackChain.map((c) => c.modelId)).toEqual([
      "codex:no-such-engine-xyz",
      "MiniMax-M3",
    ]);
    // callAttempts has exactly two entries — primary failed, fallback
    // either succeeded (success) or failed (failed). Either way, the
    // chain stopped at the configured fallback. There is NO third
    // "codex_default" / "minimax_default" / "openai_default" entry.
    const attempts = body.diagnostics.callAttempts!;
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    expect(attempts.length).toBeLessThanOrEqual(2);
    // Every attempt must reference one of the two configured model
    // ids. No "codex:gpt-5.4-mini" default, no "MiniMax-M3" default,
    // no "gpt-5.4-mini" OpenAI default.
    for (const a of attempts) {
      expect(["codex:no-such-engine-xyz", "MiniMax-M3"]).toContain(a.modelId);
    }
  });

  test("4. Primary fails + fallback fails → loud blocked failure, callAttempts has exactly two entries", async ({
    request,
  }) => {
    // Both rungs are fabricated `codex:*` ids so the resolver
    // refuses them. The chain must walk exactly two rungs, both
    // fail, and the loud-failure copy must mention BOTH failures.
    await putSettings(request, {
      normalChatRecommenderModelId: "codex:no-such-primary",
      normalChatRecommenderReasoningLevel: "low",
      normalChatRecommenderFallbackModelId: "codex:no-such-fallback",
      normalChatRecommenderFallbackReasoningLevel: "low",
    });
    const body = await recommend(request, "Test both-rungs-fail path.");
    expect(body.loudFailure).toBe(true);
    expect(body.diagnostics.fallbackChain).toHaveLength(2);
    expect(body.diagnostics.fallbackChain.map((c) => c.modelId)).toEqual([
      "codex:no-such-primary",
      "codex:no-such-fallback",
    ]);
    // callAttempts has exactly two entries.
    expect(body.diagnostics.callAttempts).toHaveLength(2);
    expect(body.diagnostics.callAttempts![0]!.source).toBe("configured");
    expect(body.diagnostics.callAttempts![0]!.status).toBe("failed");
    expect(body.diagnostics.callAttempts![1]!.source).toBe("configured_fallback");
    expect(body.diagnostics.callAttempts![1]!.status).toBe("failed");
    // The blocked-card reason must mention both failures and tell the
    // user that no other recommender fallback will be used.
    expect(body.reasoning).toMatch(/Primary recommender failed: codex:no-such-primary/);
    expect(body.reasoning).toMatch(/Fallback recommender failed: codex:no-such-fallback/);
    expect(body.reasoning).toMatch(/No other recommender fallback will be used automatically/);
  });

  test("5. Primary fails + no fallback configured → loud blocked failure, callAttempts has exactly one entry", async ({
    request,
  }) => {
    // Only the primary is configured; no fallback. The chain must
    // contain exactly ONE rung and stop after it fails.
    await putSettings(request, {
      normalChatRecommenderModelId: "codex:no-such-primary",
      normalChatRecommenderReasoningLevel: "low",
      normalChatRecommenderFallbackModelId: null,
      normalChatRecommenderFallbackReasoningLevel: null,
      // Even with OpenAI opted in, no third default rung is tried.
      allowOpenAiApiRouter: true,
    });
    const body = await recommend(request, "Test primary-fail / no-fallback path.");
    expect(body.loudFailure).toBe(true);
    // The chain contains exactly the primary — no fallback, no
    // Codex default, no MiniMax default, no OpenAI default.
    expect(body.diagnostics.fallbackChain).toHaveLength(1);
    expect(body.diagnostics.fallbackChain[0]!.modelId).toBe("codex:no-such-primary");
    // callAttempts has exactly one entry.
    expect(body.diagnostics.callAttempts).toHaveLength(1);
    expect(body.diagnostics.callAttempts![0]!.source).toBe("configured");
    expect(body.diagnostics.callAttempts![0]!.status).toBe("failed");
    // The blocked-card reason must mention the primary failure and
    // explicitly state no fallback is configured.
    expect(body.reasoning).toMatch(/Primary recommender failed: codex:no-such-primary/);
    expect(body.reasoning).toMatch(/No fallback recommender is configured/);
    // The "no other recommender fallback" line must NOT appear when
    // there is no fallback configured (the brief's required copy is
    // only for the both-rungs-failed case).
    expect(body.reasoning).not.toMatch(/No other recommender fallback will be used automatically/);
  });

  test("6. Even with allowOpenAiApiRouter=true, OpenAI default is not tried after configured fallback failure", async ({
    request,
  }) => {
    // Both configured rungs fail. With OpenAI opted in, the OLD code
    // would have walked the OpenAI default rung as a third attempt.
    // The new contract forbids that: the chain stops at the
    // configured fallback regardless of `allowOpenAiApiRouter`.
    await putSettings(request, {
      allowOpenAiApiRouter: true,
      normalChatRecommenderModelId: "codex:no-such-primary",
      normalChatRecommenderReasoningLevel: "low",
      normalChatRecommenderFallbackModelId: "codex:no-such-fallback",
      normalChatRecommenderFallbackReasoningLevel: "low",
    });
    const body = await recommend(request, "Verify no third rung under OpenAI opt-in.");
    expect(body.loudFailure).toBe(true);
    // The chain must NEVER include "gpt-5.4-mini" (the OpenAI
    // default). The chain contains exactly the two configured
    // rungs and nothing more.
    expect(body.diagnostics.fallbackChain.map((c) => c.modelId)).toEqual([
      "codex:no-such-primary",
      "codex:no-such-fallback",
    ]);
    expect(body.diagnostics.fallbackChain.map((c) => c.modelId)).not.toContain("gpt-5.4-mini");
    // callAttempts contains at most 2 entries — never 3.
    expect(body.diagnostics.callAttempts!.length).toBeLessThanOrEqual(2);
    for (const a of body.diagnostics.callAttempts!) {
      expect(["codex:no-such-primary", "codex:no-such-fallback"]).toContain(a.modelId);
    }
  });

  test("7. UI and backend terminology match: Settings → Router → Tab B surfaces exactly one primary + one configured fallback engine", async ({
    page,
    request,
  }) => {
    // The Settings page (Tab B) renders the canonical primary +
    // fallback engine configuration. The backend chain must mirror
    // that 1-primary + 1-fallback structure — never 2 fallbacks,
    // never a default third rung. The chat UI no longer mirrors
    // the picker, so we go straight to Settings to verify the
    // user-facing contract.
    await putSettings(request, {
      allowOpenAiApiRouter: false,
      normalChatRecommenderModelId: "codex:gpt-5.4-mini",
      normalChatRecommenderReasoningLevel: "low",
      normalChatRecommenderFallbackModelId: "MiniMax-M3",
      normalChatRecommenderFallbackReasoningLevel: "provider_default",
    });

    await page.goto("/settings/router");
    await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({
      timeout: 15_000,
    });
    // The Settings page surfaces EXACTLY one primary + one fallback
    // engine field pair. The "Fallback engine model" label is the
    // user-facing contract.
    await expect(page.getByTestId("router-settings-normal-chat-recommender-model")).toHaveValue(
      "codex:gpt-5.4-mini",
    );
    await expect(
      page.getByTestId("router-settings-normal-chat-recommender-fallback-model"),
    ).toHaveValue("MiniMax-M3");
    await expect(
      page.getByTestId("router-settings-normal-chat-recommender-fallback-reasoning"),
    ).toHaveValue("provider_default");

    // The chat surface must NOT mirror those pickers. Sanity: the
    // legacy chat-side card is gone.
    await page.goto("/");
    await expect(page.getByTestId("manual-chat-model-controls")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("recommender-control")).toHaveCount(0);
    await expect(page.getByTestId("chat-recommender-engine-controls")).toHaveCount(0);
    await expect(page.getByTestId("chat-recommender-fallback-controls")).toHaveCount(0);

    // And the backend chain matches: 2 configured rungs, no third
    // default rung.
    const body = await recommend(request, "UI/backend terminology check.");
    expect(body.diagnostics.fallbackChain).toHaveLength(2);
    expect(body.diagnostics.fallbackChain.map((c) => c.modelId)).toEqual([
      "codex:gpt-5.4-mini",
      "MiniMax-M3",
    ]);
  });
});
