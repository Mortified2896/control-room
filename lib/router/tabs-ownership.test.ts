import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ROUTER_SETTINGS,
  parseRouterSettings,
  parseRouterSettingsForSave,
} from "./schema.ts";
import type { EffectiveRegistry } from "@/lib/providers/registry";

/**
 * Schema-level regression tests for the split `/settings/router` UI.
 *
 * The Settings UI now exposes three focused tabs (A · Manual chat
 * picker, B · Recommender engine, C · Recommender candidates). The
 * backend schema keeps the same field names but the UI assigns them
 * different owners:
 *
 *   - Manual picker (Tab A)         → writes via /api/model-selector-prefs
 *                                     (a separate singleton row), NOT
 *                                     through RouterSettings.
 *   - Engine (Tab B)                → `normalChatRecommenderModelId` +
 *                                     `normalChatRecommenderReasoningLevel`.
 *   - Candidates (Tab C)           → `normalChatRecommenderAllowedModels`
 *                                     (model allowlist) +
 *                                     `allowedCombos` (per-(model, level)
 *                                     option allowlist).
 *
 * These tests pin the schema's split semantics so that future schema
 * refactors cannot silently overload one field for both engine and
 * candidates — the brief is explicit on this point.
 */

test("Default engine fields are distinct from default candidate fields", () => {
  assert.equal(DEFAULT_ROUTER_SETTINGS.normalChatRecommenderModelId, "codex:gpt-5.4-mini");
  assert.equal(DEFAULT_ROUTER_SETTINGS.normalChatRecommenderReasoningLevel, "low");
  // Default = no restriction (every enabled model is implicitly allowed).
  assert.equal(DEFAULT_ROUTER_SETTINGS.normalChatRecommenderAllowedModels, null);
  // Default allowedCombos includes all Codex subscription models with their reasoning levels.
  // The exact count may vary; we just verify the default recommender is in there.
  assert.ok(
    DEFAULT_ROUTER_SETTINGS.allowedCombos.some(
      (c) => c.modelId === "codex:gpt-5.4-mini" && c.reasoningLevel === "low",
    ),
    "default recommender (codex:gpt-5.4-mini, low) must be in allowedCombos",
  );
  // Verify the new long-prompt lane fields exist and have defaults.
  assert.ok(
    "longPromptThresholdTokens" in DEFAULT_ROUTER_SETTINGS,
    "longPromptThresholdTokens field must exist",
  );
  assert.ok(
    "longPromptRecommenderModelId" in DEFAULT_ROUTER_SETTINGS,
    "longPromptRecommenderModelId field must exist",
  );
  assert.ok(
    "longPromptRecommenderFallbackModelId" in DEFAULT_ROUTER_SETTINGS,
    "longPromptRecommenderFallbackModelId field must exist",
  );
  assert.equal(
    DEFAULT_ROUTER_SETTINGS.longPromptThresholdTokens,
    120_000,
    "default token threshold should be 120,000",
  );
  assert.equal(
    DEFAULT_ROUTER_SETTINGS.longPromptRecommenderModelId,
    "codex:gpt-5.4-mini",
    "default long-prompt recommender should match default recommender",
  );
});

test("parseRouterSettings preserves the engine-vs-candidate separation", () => {
  const parsed = parseRouterSettings({
    normalChatRecommenderModelId: "MiniMax-M3",
    normalChatRecommenderReasoningLevel: "adaptive",
    normalChatRecommenderAllowedModels: ["MiniMax-M3", "gpt-5.4-mini"],
    allowedCombos: [
      { modelId: "MiniMax-M3", reasoningLevel: "enabled" },
      { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
    ],
  });
  assert.equal(parsed.normalChatRecommenderModelId, "MiniMax-M3");
  assert.equal(parsed.normalChatRecommenderReasoningLevel, "adaptive");
  assert.deepEqual(parsed.normalChatRecommenderAllowedModels, ["MiniMax-M3", "gpt-5.4-mini"]);
  assert.equal(parsed.allowedCombos.length, 2);
});

test("parseRouterSettingsForSave rejects engine settings that conflict with candidates", () => {
  // The schema validator must catch engine/candidate inconsistencies
  // at the save boundary, even though the field names are unrelated.
  // Here: opt-in off + openai engine + openai candidate. Both must be
  // rejected with field-level errors so the UI can highlight them.
  const registry: EffectiveRegistry = {
    models: [
      {
        providerId: "openai",
        modelId: "gpt-5.4-mini",
        displayLabel: "GPT-5.4 Mini",
        configured: true,
        available: true,
        stale: false,
        supportsReasoning: true,
        reasoningCapability: {
          kind: "effort_levels",
          control: "supported",
          options: [{ value: "low" }, { value: "medium" }],
        } as EffectiveRegistry["models"][number]["reasoningCapability"],
        supportedReasoningLevels: ["low", "medium"],
        tier: "standard",
        usableForChat: true,
        manualSelectorVisible: true,
        manuallyOverridden: false,
        routerEligible: true,
        capabilities: {
          reasoning: true,
          vision: false,
          images: false,
          functionCalling: false,
          structuredOutput: false,
          streaming: true,
        },
        provenance: "local_meta",
      },
    ],
    defaults: { manualModelId: "gpt-5.4-mini", reasoningLevel: "low" },
    discovery: {
      modelIds: ["gpt-5.4-mini"],
      previousModelIds: [],
      fetchedAt: new Date(),
      httpStatus: 200,
      source: "openai",
      rawCount: 1,
      errorMessage: null,
      updatedAt: new Date(),
    },
    selectorPrefs: {},
    counts: {
      discovered: 1,
      discoveredConfigured: 1,
      discoveredUnclassified: 0,
      configuredAvailable: 1,
      stale: 0,
      manualSelectorVisible: 1,
      routerEligible: 1,
    },
    fakeMode: false,
  };
  const result = parseRouterSettingsForSave(
    {
      normalChatRecommenderModelId: "gpt-5.4-mini",
      normalChatRecommenderAllowedModels: ["gpt-5.4-mini"],
      allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
      fallbackModelId: "gpt-5.4-mini",
      fallbackReasoningLevel: "low",
    },
    registry,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.errors.some(
        (e) =>
          e.field === "normalChatRecommenderModelId" &&
          /OpenAI API router use is disabled/.test(e.message),
      ),
      `expected OpenAI-API cost-safety error on the engine field, got: ${JSON.stringify(result.errors)}`,
    );
  }
});

test("parseRouterSettingsForSave accepts a Codex subscription engine + MiniMax M3 candidate", () => {
  // Mix two providers across the engine + candidate boundary. This is
  // a normal configuration (Cheap Codex login + M3 fallback) and must
  // pass validation. The schema enforces no relationship between engine
  // and candidate — each side validates independently.
  const result = parseRouterSettingsForSave({
    normalChatRecommenderModelId: "codex:gpt-5.4-mini",
    normalChatRecommenderReasoningLevel: "low",
    normalChatRecommenderAllowedModels: ["MiniMax-M3", "gpt-5.4-mini"],
    allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
    fallbackModelId: "gpt-5.4-mini",
    fallbackReasoningLevel: "low",
  });
  // Without a registry the validator falls back to the static pool,
  // which still rejects API-billed candidates. MiniMax M3 + codex are
  // subscription, so the result MUST be ok.
  assert.equal(result.ok, true);
});

test("parseRouterSettingsForSave accepts an empty normalChatRecommenderAllowedModels (block all)", () => {
  const result = parseRouterSettingsForSave({
    normalChatRecommenderAllowedModels: [],
    allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
    fallbackModelId: "gpt-5.4-mini",
    fallbackReasoningLevel: "low",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.normalChatRecommenderAllowedModels, []);
  }
});
