import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPanelForLoudFailure,
  buildPanelFromRecommenderValue,
  RouterModelTreatedAsExecutionError,
} from "./panel-builder";
import type { EffectiveRegistry } from "@/lib/providers/registry";

const baseRegistry = {
  models: [
    {
      modelId: "codex:gpt-5.4-mini",
      tier: "cheap",
      manualSelectorVisible: true,
      usableForChat: true,
      supportsReasoningLevels: true,
      supportedReasoningLevels: ["none", "low", "medium", "high"],
      supportedExecutionTargets: ["codex_cli"] as ReadonlyArray<
        "chat_model" | "codex_cli" | "minimax_cli"
      >,
    },
    {
      modelId: "codex:gpt-5.5",
      tier: "expensive",
      manualSelectorVisible: true,
      usableForChat: true,
      supportsReasoningLevels: true,
      supportedReasoningLevels: ["none", "minimal", "low", "medium", "high", "xhigh"],
      supportedExecutionTargets: ["codex_cli"] as ReadonlyArray<
        "chat_model" | "codex_cli" | "minimax_cli"
      >,
    },
    {
      modelId: "MiniMax-M3",
      tier: "cheap",
      manualSelectorVisible: true,
      usableForChat: true,
      supportsReasoningLevels: true,
      supportedReasoningLevels: ["enabled", "disabled"],
      supportedExecutionTargets: ["chat_model", "minimax_cli"] as ReadonlyArray<
        "chat_model" | "codex_cli" | "minimax_cli"
      >,
    },
  ],
} as unknown as EffectiveRegistry;

const baseContext = {
  decision: "harness_needed" as const,
  explanation: "Asks whether a project file exists.",
};

const baseValue = {
  recommendedModelId: "codex:gpt-5.4-mini",
  recommendedProvider: "codex",
  recommendedReasoningLevel: "low" as string | null,
  reasoning: "Cheap reasoning on Codex GPT-5.4 Mini to read project files.",
  alternatives: [
    { modelId: "codex:gpt-5.5", provider: "codex", recommendedReasoningLevel: "low", reason: "x" },
  ],
};

const baseLevel = "low";

function defaultAllowedReasoningValues(modelId: string): ReadonlyArray<string> {
  const entry = baseRegistry.models.find((m) => m.modelId === modelId);
  if (!entry) return [];
  return entry.supportedReasoningLevels;
}

test("buildPanelFromRecommenderValue returns a panel with context + package + meta", () => {
  const panel = buildPanelFromRecommenderValue({
    recommenderValue: baseValue,
    contextDecision: baseContext,
    level: baseLevel,
    registry: baseRegistry,
    executionBlocklist: ["codex:gpt-5.4-mini-recommender"],
    registryToAllowedReasoningValues: defaultAllowedReasoningValues,
    latencyMs: 1500,
  });
  assert.equal(panel.contextDecision.recommended, "harness_needed");
  assert.equal(panel.contextDecision.explanation, baseContext.explanation);
  assert.equal(panel.executionPackage.model.recommended, "codex:gpt-5.4-mini");
  assert.deepEqual(panel.executionPackage.model.alternatives, ["codex:gpt-5.5"]);
  assert.equal(panel.executionPackage.reasoningLevel.recommended, "low");
  assert.deepEqual(panel.executionPackage.reasoningLevel.supportedValues, [
    "none",
    "low",
    "medium",
    "high",
  ]);
  // Codex-catalog rows go through the harness.
  assert.equal(panel.executionPackage.harness.recommended, "repo_file_harness");
  assert.deepEqual(panel.executionPackage.harness.alternatives, [
    "normal_chat",
    "repo_file_harness",
  ]);
  // The package explanation includes the harness hint.
  assert.match(panel.executionPackage.explanation, /repo\/file harness/);
  assert.ok(panel.confidence > 0 && panel.confidence <= 1);
  assert.equal(panel.costTier, "cheap");
  assert.equal(panel.latencyMs, 1500);
});

test("buildPanelFromRecommenderValue keeps the GPT-5.5 low reasoning representation verbatim", () => {
  // The brief: "for GPT-5.5 low reasoning, internal representation must
  // remain model: codex:gpt-5.5, reasoningLevel: low". No enum
  // translation, no normalization.
  const panel = buildPanelFromRecommenderValue({
    recommenderValue: {
      ...baseValue,
      recommendedModelId: "codex:gpt-5.5",
      recommendedReasoningLevel: "low",
    },
    contextDecision: baseContext,
    level: "low",
    registry: baseRegistry,
    executionBlocklist: [],
    registryToAllowedReasoningValues: defaultAllowedReasoningValues,
    latencyMs: 1000,
  });
  assert.equal(panel.executionPackage.model.recommended, "codex:gpt-5.5");
  assert.equal(panel.executionPackage.reasoningLevel.recommended, "low");
  assert.equal(panel.costTier, "expensive");
});

test("buildPanelFromRecommenderValue maps a Codex-catalog pick to repo_file_harness", () => {
  const panel = buildPanelFromRecommenderValue({
    recommenderValue: baseValue,
    contextDecision: baseContext,
    level: baseLevel,
    registry: baseRegistry,
    executionBlocklist: [],
    registryToAllowedReasoningValues: defaultAllowedReasoningValues,
    latencyMs: 1000,
  });
  assert.equal(panel.executionPackage.harness.recommended, "repo_file_harness");
});

test("buildPanelFromRecommenderValue throws when the recommender pick is a ROUTER model id", () => {
  // The brief: "ROUTER models must never be treated as execution
  // models". A regression that lets the recommender's pick pass
  // through the blocklist must throw, not silently emit the
  // forbidden id.
  assert.throws(
    () =>
      buildPanelFromRecommenderValue({
        recommenderValue: {
          ...baseValue,
          recommendedModelId: "codex:gpt-5.4-mini-recommender",
        },
        contextDecision: baseContext,
        level: baseLevel,
        registry: baseRegistry,
        executionBlocklist: ["codex:gpt-5.4-mini-recommender"],
        registryToAllowedReasoningValues: defaultAllowedReasoningValues,
        latencyMs: 1000,
      }),
    RouterModelTreatedAsExecutionError,
  );
});

test("buildPanelFromRecommenderValue silently drops blocklisted alternatives", () => {
  // A ROUTER id appearing only as an alternative must NOT throw
  // — the alternative is a UI suggestion, not a model that will
  // run. The builder drops it silently so a valid pick is not
  // hidden behind a router-id leak.
  const panel = buildPanelFromRecommenderValue({
    recommenderValue: {
      ...baseValue,
      alternatives: [
        {
          modelId: "MiniMax-M3",
          provider: "minimax",
          recommendedReasoningLevel: "low",
          reason: "x",
        },
        {
          modelId: "codex:gpt-5.5",
          provider: "codex",
          recommendedReasoningLevel: "low",
          reason: "x",
        },
      ],
    },
    contextDecision: baseContext,
    level: baseLevel,
    registry: baseRegistry,
    executionBlocklist: ["MiniMax-M3"],
    registryToAllowedReasoningValues: defaultAllowedReasoningValues,
    latencyMs: 1000,
  });
  assert.equal(panel.executionPackage.model.recommended, "codex:gpt-5.4-mini");
  assert.deepEqual(panel.executionPackage.model.alternatives, ["codex:gpt-5.5"]);
});

test("buildPanelFromRecommenderValue strips blocklisted alternatives silently when the pick is allowed", () => {
  // The blocklist filter applies to alternatives as well as the
  // primary pick. If the alternative is a router id, it must
  // not appear in `executionPackage.model.alternatives`.
  const panel = buildPanelFromRecommenderValue({
    recommenderValue: {
      ...baseValue,
      alternatives: [
        {
          modelId: "codex:gpt-5.4-mini-recommender",
          provider: "codex",
          recommendedReasoningLevel: "low",
          reason: "x",
        },
        {
          modelId: "codex:gpt-5.5",
          provider: "codex",
          recommendedReasoningLevel: "low",
          reason: "x",
        },
      ],
    },
    contextDecision: baseContext,
    level: baseLevel,
    registry: baseRegistry,
    executionBlocklist: ["codex:gpt-5.4-mini-recommender"],
    registryToAllowedReasoningValues: defaultAllowedReasoningValues,
    latencyMs: 1000,
  });
  assert.equal(panel.executionPackage.model.recommended, "codex:gpt-5.4-mini");
  assert.deepEqual(panel.executionPackage.model.alternatives, ["codex:gpt-5.5"]);
});

test("buildPanelFromRecommenderValue falls back to 'none' when the model has no reasoning controls", () => {
  const panel = buildPanelFromRecommenderValue({
    recommenderValue: {
      recommendedModelId: "MiniMax-M3",
      recommendedProvider: "minimax",
      recommendedReasoningLevel: null,
      reasoning: "Cheap M3 thinking mode.",
      alternatives: [],
    },
    contextDecision: baseContext,
    level: null,
    registry: baseRegistry,
    executionBlocklist: [],
    registryToAllowedReasoningValues: (modelId: string) => {
      const entry = baseRegistry.models.find((m) => m.modelId === modelId);
      return entry?.supportedReasoningLevels ?? [];
    },
    latencyMs: 1000,
  });
  assert.equal(panel.executionPackage.reasoningLevel.recommended, "enabled");
  assert.deepEqual(panel.executionPackage.reasoningLevel.supportedValues, ["enabled", "disabled"]);
});

test("buildPanelFromRecommenderValue keeps the context explanation separate from the package explanation", () => {
  const panel = buildPanelFromRecommenderValue({
    recommenderValue: baseValue,
    contextDecision: {
      decision: "chat_only",
      explanation: "Conceptual question; no project files needed.",
    },
    level: baseLevel,
    registry: baseRegistry,
    executionBlocklist: [],
    registryToAllowedReasoningValues: defaultAllowedReasoningValues,
    latencyMs: 1000,
  });
  assert.match(panel.contextDecision.explanation, /Conceptual question/);
  assert.match(panel.executionPackage.explanation, /Cheap reasoning/);
  assert.notEqual(panel.contextDecision.explanation, panel.executionPackage.explanation);
});

test("buildPanelFromRecommenderValue returns ONE execution-package explanation string", () => {
  const panel = buildPanelFromRecommenderValue({
    recommenderValue: baseValue,
    contextDecision: baseContext,
    level: baseLevel,
    registry: baseRegistry,
    executionBlocklist: [],
    registryToAllowedReasoningValues: defaultAllowedReasoningValues,
    latencyMs: 1000,
  });
  // The wire shape must expose `executionPackage.explanation` as
  // a SINGLE string — not a nested object, not an array. The brief
  // forbids per-field explanations on the panel by default.
  assert.equal(typeof panel.executionPackage.explanation, "string");
});

test("buildPanelForLoudFailure returns a chat_only panel with the user's current selection", () => {
  // No silent API-billing fallback: the loud-failure path must
  // surface the user's current selection, not a third Codex /
  // MiniMax default rung.
  const panel = buildPanelForLoudFailure({
    contextExplanation: "Classifier unavailable.",
    currentModelId: "codex:gpt-5.4-mini",
    currentReasoningLevel: "low",
    registry: baseRegistry,
    latencyMs: 0,
  });
  assert.equal(panel.contextDecision.recommended, "chat_only");
  assert.equal(panel.executionPackage.model.recommended, "codex:gpt-5.4-mini");
  assert.equal(panel.executionPackage.reasoningLevel.recommended, "low");
  assert.equal(panel.confidence, 0);
});

test("buildPanelForLoudFailure maps a MiniMax-M3 current selection to normal_chat", () => {
  // Without Codex support, M3 stays on the normal-chat harness
  // — no silent fallback to a codex_cli harness.
  const panel = buildPanelForLoudFailure({
    contextExplanation: "Recommender unavailable.",
    currentModelId: "MiniMax-M3",
    currentReasoningLevel: null,
    registry: baseRegistry,
    latencyMs: 0,
  });
  assert.equal(panel.executionPackage.harness.recommended, "repo_file_harness");
  assert.equal(panel.executionPackage.reasoningLevel.recommended, "enabled");
});