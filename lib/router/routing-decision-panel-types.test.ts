import assert from "node:assert/strict";
import test from "node:test";

import {
  computeChangedFields,
  executionPayloadModelId,
  getExecutionEligibleModelIds,
  mapHarnessValueToInternal,
  mapInternalToHarnessValue,
  type RoutingDecisionPanel,
} from "./routing-decision-panel-types";

const basePanel: RoutingDecisionPanel = {
  contextDecision: {
    recommended: "chat_only",
    explanation: "Conceptual question; no project files needed.",
  },
  executionPackage: {
    model: { recommended: "codex:gpt-5.5", alternatives: ["codex:gpt-5.4-mini", "MiniMax-M3"] },
    reasoningLevel: { recommended: "low", supportedValues: ["none", "low", "medium", "high", "xhigh"] },
    harness: { recommended: "repo_file_harness", alternatives: ["normal_chat", "repo_file_harness"] },
    explanation: "Use the repo/file harness with low-reasoning GPT-5.5 to read AGENTS.md cheaply.",
  },
  confidence: 0.86,
  costTier: "expensive",
  latencyMs: 13700,
};

test("computeChangedFields returns an empty array when no field differs", () => {
  const changed = computeChangedFields(basePanel, {
    contextDecision: basePanel.contextDecision.recommended,
    modelId: basePanel.executionPackage.model.recommended,
    reasoningLevel: basePanel.executionPackage.reasoningLevel.recommended,
    harness: basePanel.executionPackage.harness.recommended,
  });
  assert.deepEqual(changed, []);
});

test("computeChangedFields flags context when the context decision changes", () => {
  const changed = computeChangedFields(basePanel, {
    contextDecision: "harness_needed",
    modelId: basePanel.executionPackage.model.recommended,
    reasoningLevel: basePanel.executionPackage.reasoningLevel.recommended,
    harness: basePanel.executionPackage.harness.recommended,
  });
  assert.deepEqual(changed, ["context"]);
});

test("computeChangedFields flags model when the model changes", () => {
  const changed = computeChangedFields(basePanel, {
    contextDecision: basePanel.contextDecision.recommended,
    modelId: "MiniMax-M3",
    reasoningLevel: basePanel.executionPackage.reasoningLevel.recommended,
    harness: basePanel.executionPackage.harness.recommended,
  });
  assert.deepEqual(changed, ["model"]);
});

test("computeChangedFields flags reasoning when the reasoning level changes", () => {
  const changed = computeChangedFields(basePanel, {
    contextDecision: basePanel.contextDecision.recommended,
    modelId: basePanel.executionPackage.model.recommended,
    reasoningLevel: "high",
    harness: basePanel.executionPackage.harness.recommended,
  });
  assert.deepEqual(changed, ["reasoning"]);
});

test("computeChangedFields flags harness when the harness changes", () => {
  const changed = computeChangedFields(basePanel, {
    contextDecision: basePanel.contextDecision.recommended,
    modelId: basePanel.executionPackage.model.recommended,
    reasoningLevel: basePanel.executionPackage.reasoningLevel.recommended,
    harness: "normal_chat",
  });
  assert.deepEqual(changed, ["harness"]);
});

test("computeChangedFields flags every field when all four differ", () => {
  const changed = computeChangedFields(basePanel, {
    contextDecision: "harness_needed",
    modelId: "MiniMax-M3",
    reasoningLevel: "high",
    harness: "normal_chat",
  });
  assert.deepEqual([...changed].sort(), ["context", "harness", "model", "reasoning"]);
});

test("computeChangedFields preserves the order [context, model, reasoning, harness]", () => {
  // Order matters for the telemetry / KPI counters — the brief
  // pins the order of the diff payload so dashboards can be
  // built against a stable shape.
  const changed = computeChangedFields(basePanel, {
    contextDecision: "harness_needed",
    modelId: "MiniMax-M3",
    reasoningLevel: "high",
    harness: "normal_chat",
  });
  assert.deepEqual(changed, ["context", "model", "reasoning", "harness"]);
});

test("mapHarnessValueToInternal maps normal_chat to the chat route with no harness", () => {
  const out = mapHarnessValueToInternal("normal_chat");
  assert.deepEqual(out, { threadMode: "chat", harnessId: null });
});

test("mapHarnessValueToInternal maps repo_file_harness to a coding-task + codex_cli harness", () => {
  const out = mapHarnessValueToInternal("repo_file_harness");
  assert.deepEqual(out, { threadMode: "coding_task", harnessId: "codex_cli" });
});

test("mapInternalToHarnessValue round-trips with mapHarnessValueToInternal", () => {
  for (const h of ["normal_chat", "repo_file_harness"] as const) {
    const internal = mapHarnessValueToInternal(h);
    const back = mapInternalToHarnessValue(internal);
    assert.equal(back, h);
  }
});

test("executionPayloadModelId keeps the reasoning level verbatim for codex:gpt-5.5 + 'low'", () => {
  // The brief: "for GPT-5.5 low reasoning, internal representation must
  // remain model: codex:gpt-5.5, reasoningLevel: low". No normalization.
  const registry = {
    models: [
      {
        modelId: "codex:gpt-5.5",
        manualSelectorVisible: true,
        usableForChat: true,
        supportsReasoningLevels: true,
      },
    ],
  } as unknown as Parameters<typeof executionPayloadModelId>[0]["registry"];
  const out = executionPayloadModelId({
    modelId: "codex:gpt-5.5",
    reasoningLevel: "low",
    registry,
  });
  assert.equal(out.modelId, "codex:gpt-5.5");
  assert.equal(out.reasoningLevel, "low");
});

test("executionPayloadModelId strips reasoning to null when the model does not support reasoning", () => {
  const registry = {
    models: [
      {
        modelId: "minimax:MiniMax-M3",
        manualSelectorVisible: true,
        usableForChat: true,
        // MiniMax M3 advertises reasoning controls as supported but
        // the model registry may mark a discovered-only id as
        // `supportsReasoningLevels: false`. The helper must still
        // strip reasoning to null in that case.
        supportsReasoningLevels: false,
      },
    ],
  } as unknown as Parameters<typeof executionPayloadModelId>[0]["registry"];
  const out = executionPayloadModelId({
    modelId: "minimax:MiniMax-M3",
    reasoningLevel: "low",
    registry,
  });
  assert.equal(out.modelId, "minimax:MiniMax-M3");
  assert.equal(out.reasoningLevel, null);
});

test("executionPayloadModelId passes the reasoning level through when the registry is null", () => {
  // Defensive path: when the registry cannot be loaded (DB
  // unavailable, test stub), the helper passes the value through
  // and the chat route's preflight is the second line of defense.
  const out = executionPayloadModelId({
    modelId: "codex:gpt-5.5",
    reasoningLevel: "medium",
    registry: null,
  });
  assert.equal(out.modelId, "codex:gpt-5.5");
  assert.equal(out.reasoningLevel, "medium");
});

test("getExecutionEligibleModelIds excludes the configured recommender primary and fallback", () => {
  const registry = {
    models: [
      {
        modelId: "codex:gpt-5.4-mini",
        manualSelectorVisible: true,
        usableForChat: true,
      },
      { modelId: "codex:gpt-5.5", manualSelectorVisible: true, usableForChat: true },
      { modelId: "MiniMax-M3", manualSelectorVisible: true, usableForChat: true },
      { modelId: "gpt-5.4-mini", manualSelectorVisible: true, usableForChat: true },
    ],
  } as unknown as Parameters<typeof getExecutionEligibleModelIds>[1];
  const out = getExecutionEligibleModelIds(
    {
      normalChatRecommenderModelId: "codex:gpt-5.4-mini",
      normalChatRecommenderFallbackModelId: "MiniMax-M3",
    },
    registry,
  );
  assert.deepEqual(out, ["codex:gpt-5.5", "gpt-5.4-mini"]);
});

test("getExecutionEligibleModelIds excludes only the primary when no fallback is configured", () => {
  const registry = {
    models: [
      { modelId: "codex:gpt-5.4-mini", manualSelectorVisible: true, usableForChat: true },
      { modelId: "codex:gpt-5.5", manualSelectorVisible: true, usableForChat: true },
      { modelId: "MiniMax-M3", manualSelectorVisible: true, usableForChat: true },
    ],
  } as unknown as Parameters<typeof getExecutionEligibleModelIds>[1];
  const out = getExecutionEligibleModelIds(
    {
      normalChatRecommenderModelId: "codex:gpt-5.4-mini",
      normalChatRecommenderFallbackModelId: null,
    },
    registry,
  );
  assert.deepEqual(out, ["codex:gpt-5.5", "MiniMax-M3"]);
});

test("getExecutionEligibleModelIds de-duplicates the blocklist when both ids match", () => {
  // Defensive: if a user accidentally configures the fallback to
  // equal the primary, the helper must exclude the id exactly
  // once and not silently fail or include it. The registry is
  // unaffected.
  const registry = {
    models: [
      { modelId: "codex:gpt-5.4-mini", manualSelectorVisible: true, usableForChat: true },
      { modelId: "codex:gpt-5.5", manualSelectorVisible: true, usableForChat: true },
    ],
  } as unknown as Parameters<typeof getExecutionEligibleModelIds>[1];
  const out = getExecutionEligibleModelIds(
    {
      normalChatRecommenderModelId: "codex:gpt-5.4-mini",
      normalChatRecommenderFallbackModelId: "codex:gpt-5.4-mini",
    },
    registry,
  );
  assert.deepEqual(out, ["codex:gpt-5.5"]);
});

test("getExecutionEligibleModelIds drops rows that are not chat-usable", () => {
  const registry = {
    models: [
      { modelId: "codex:gpt-5.5", manualSelectorVisible: true, usableForChat: true },
      { modelId: "stale-model", manualSelectorVisible: true, usableForChat: false },
      { modelId: "hidden-model", manualSelectorVisible: false, usableForChat: true },
    ],
  } as unknown as Parameters<typeof getExecutionEligibleModelIds>[1];
  const out = getExecutionEligibleModelIds(
    { normalChatRecommenderModelId: "codex:gpt-5.4-mini", normalChatRecommenderFallbackModelId: null },
    registry,
  );
  assert.deepEqual(out, ["codex:gpt-5.5"]);
});

test("getExecutionEligibleModelIds returns an empty array when the registry is null", () => {
  const out = getExecutionEligibleModelIds(
    { normalChatRecommenderModelId: "codex:gpt-5.4-mini", normalChatRecommenderFallbackModelId: null },
    null,
  );
  assert.deepEqual(out, []);
});