import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CODING_MODEL_ROUTING_POLICY,
  buildCodingHarnessCandidatesFromModels,
  buildRequestPayloadForTokenCount,
  runCodingHarnessRecommendation,
  selectCodingRecommenderLane,
  validateCodingRecommenderOutput,
  type CodingHarnessCandidate,
} from "./model-routing";
import type { HarnessStatusSnapshot } from "./registry";

const now = new Date().toISOString();
type Policy = typeof DEFAULT_CODING_MODEL_ROUTING_POLICY;

function policy(overrides: Partial<Policy>): Policy {
  return { ...DEFAULT_CODING_MODEL_ROUTING_POLICY, ...overrides };
}

test("default Codex recommender engines use gpt-5.5 with low reasoning", () => {
  const lane = selectCodingRecommenderLane({
    payload: buildRequestPayloadForTokenCount({ instruction: "small fix" }),
  });
  assert.equal(DEFAULT_CODING_MODEL_ROUTING_POLICY.standardModelId, "codex:gpt-5.5");
  assert.equal(DEFAULT_CODING_MODEL_ROUTING_POLICY.largeContextModelId, "codex:gpt-5.5");
  assert.equal(lane.primary.modelId, "codex:gpt-5.5");
  assert.equal(lane.primary.reasoningLevel, "low");
});

function centralCandidates(): CodingHarnessCandidate[] {
  return [
    { harnessId: "codex_cli", harnessLabel: "Codex CLI", providerPath: "Codex CLI / ChatGPT login", billingPath: "ChatGPT subscription", status: "available", unavailableReason: null, supportsReasoningLevels: true, modelId: "gpt-5.5", reasoningLevel: "low" },
    { harnessId: "codex_cli", harnessLabel: "Codex CLI", providerPath: "Codex CLI / ChatGPT login", billingPath: "ChatGPT subscription", status: "available", unavailableReason: null, supportsReasoningLevels: true, modelId: "gpt-5.4", reasoningLevel: "low" },
    { harnessId: "codex_cli", harnessLabel: "Codex CLI", providerPath: "Codex CLI / ChatGPT login", billingPath: "ChatGPT subscription", status: "available", unavailableReason: null, supportsReasoningLevels: true, modelId: "gpt-5.4-mini", reasoningLevel: "low" },
    { harnessId: "minimax_cli", harnessLabel: "MiniMax CLI", providerPath: "MiniMax CLI / MiniMax token plan", billingPath: "MiniMax token plan", status: "available", unavailableReason: null, supportsReasoningLevels: false, modelId: "MiniMax-M3", reasoningLevel: "provider_default" },
  ];
}

test("coding candidates are derived from central availability and reasoning levels", () => {
  const candidates = buildCodingHarnessCandidatesFromModels([
    {
      providerId: "codex",
      providerLabel: "Codex subscription",
      modelId: "codex:gpt-5.5",
      modelLabel: "Codex · GPT-5.5",
      enabled: true,
      accessPath: "codex_chatgpt",
      billingLabel: "Codex subscription",
      capabilityKind: "agent_backend",
      description: "subscription-backed",
      supportedExecutionTargets: ["codex_cli"],
      supportsReasoningLevels: true,
      reasoningCapability: { kind: "effort_levels", control: "supported", options: [{ value: "low", label: "low" }] },
      reasoningLevels: ["low"],
      tier: "expensive",
    },
    {
      providerId: "codex",
      providerLabel: "Codex subscription",
      modelId: "codex:gpt-5.5-small",
      modelLabel: "Codex · GPT-5.5 Small",
      enabled: false,
      accessPath: "codex_chatgpt",
      billingLabel: "Codex subscription",
      capabilityKind: "agent_backend",
      description: "disabled legacy row",
      supportedExecutionTargets: ["codex_cli"],
      supportsReasoningLevels: true,
      reasoningCapability: { kind: "effort_levels", control: "supported", options: [{ value: "low", label: "low" }] },
      reasoningLevels: ["low"],
      tier: "cheap",
    },
  ], snapshots());
  assert.ok(candidates.some((c) => c.harnessId === "codex_cli" && c.modelId === "gpt-5.5" && c.reasoningLevel === "low"));
  assert.equal(candidates.some((c) => c.modelId === "gpt-5.5-small"), false);
});

function snapshots(overrides: Partial<HarnessStatusSnapshot> = {}): HarnessStatusSnapshot[] {
  return [
    { id: "codex_cli", status: "available", unavailableReason: null, checkedAt: now, ...overrides },
    { id: "minimax_cli", status: "available", unavailableReason: null, checkedAt: now },
  ];
}

test("long-prompt threshold chooses recommender lane only, not execution model", async () => {
  const payload = buildRequestPayloadForTokenCount({ instruction: "large", projectContext: "x".repeat(10_000) });
  const p = policy({
    largeContextThresholdTokens: 100,
    standardModelId: "codex:router-default",
    largeContextModelId: "codex:router-long",
  });
  const lane = selectCodingRecommenderLane({ payload, policy: p });
  assert.equal(lane.lane, "long-prompt");
  assert.equal(lane.primary.modelId, "codex:router-long");

  const result = await runCodingHarnessRecommendation({
    payload,
    snapshots: snapshots(),
    candidates: centralCandidates(),
    policy: p,
    runRung: async () => ({
      selectedHarness: "minimax_cli",
      selectedModelId: "MiniMax-M3",
      selectedReasoningLevel: "provider_default",
      harnessExplanation: "MiniMax CLI is available for this task.",
      modelExplanation: "The recommender selected MiniMax-M3 from the authorized candidates.",
      alternatives: [],
    }),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.lane, "long-prompt");
    assert.equal(result.recommender.modelId, "codex:router-long");
    assert.equal(result.recommendation.selectedModelId, "MiniMax-M3");
  }
});

test("router model is not execution default; execution model comes from recommender output", async () => {
  const result = await runCodingHarnessRecommendation({
    payload: buildRequestPayloadForTokenCount({ instruction: "fix a small typo" }),
    snapshots: snapshots(),
    candidates: centralCandidates(),
    policy: policy({ standardModelId: "codex:router-engine" }),
    runRung: async () => ({
      selectedHarness: "codex_cli",
      selectedModelId: "gpt-5.5",
      selectedReasoningLevel: "low",
      harnessExplanation: "Codex CLI is available and suitable for repo edits.",
      modelExplanation: "The recommender chose gpt-5.5 with low reasoning from Codex's authorized execution candidates.",
      alternatives: [],
    }),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.recommender.modelId, "codex:router-engine");
    assert.equal(result.recommendation.selectedModelId, "gpt-5.5");
    assert.equal(result.recommendation.selectedReasoningLevel, "low");
    assert.notEqual(result.recommendation.selectedModelId, result.recommender.modelId);
  }
});

test("router fallback model is not execution default; fallback output supplies execution model", async () => {
  const result = await runCodingHarnessRecommendation({
    payload: buildRequestPayloadForTokenCount({ instruction: "fix the bug" }),
    snapshots: snapshots(),
    candidates: centralCandidates(),
    policy: policy({
      standardModelId: "codex:primary-router",
      defaultRouteFallbackModelId: "MiniMax-M3",
    }),
    runRung: async ({ rung }) => {
      if (rung.source === "configured") throw new Error("primary quota failed");
      return {
        selectedHarness: "codex_cli",
        selectedModelId: "gpt-5.4-mini",
        selectedReasoningLevel: "low",
        harnessExplanation: "Fallback recommender selected Codex CLI after evaluating candidates.",
        modelExplanation: "Fallback recommender selected gpt-5.4-mini; MiniMax-M3 was only the decision engine.",
        alternatives: [],
      };
    },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.recommender.modelId, "MiniMax-M3");
    assert.equal(result.recommendation.selectedModelId, "gpt-5.4-mini");
    assert.notEqual(result.recommendation.selectedModelId, "MiniMax-M3");
  }
});

test("harness comes from recommender output", async () => {
  const result = await runCodingHarnessRecommendation({
    payload: buildRequestPayloadForTokenCount({ instruction: "debug this" }),
    snapshots: snapshots(),
    candidates: centralCandidates(),
    runRung: async () => ({
      selectedHarness: "minimax_cli",
      selectedModelId: "MiniMax-M3",
      selectedReasoningLevel: "provider_default",
      harnessExplanation: "The recommender chose MiniMax CLI for this debugging request.",
      modelExplanation: "MiniMax-M3 is the only authorized MiniMax execution model.",
      alternatives: [],
    }),
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.recommendation.selectedHarness, "minimax_cli");
});

test("explanations are required for harness and model", () => {
  const candidates = [
    {
      harnessId: "codex_cli" as const,
      harnessLabel: "Codex CLI",
      providerPath: "Codex CLI / ChatGPT login",
      billingPath: "ChatGPT subscription",
      status: "available" as const,
      unavailableReason: null,
      supportsReasoningLevels: true,
      modelId: "gpt-5.5",
      reasoningLevel: "low",
    },
  ];
  assert.equal(validateCodingRecommenderOutput({
    selectedHarness: "codex_cli",
    selectedModelId: "gpt-5.5",
    selectedReasoningLevel: "low",
    harnessExplanation: "",
    modelExplanation: "model reason",
  }, candidates).ok, false);
  assert.equal(validateCodingRecommenderOutput({
    selectedHarness: "codex_cli",
    selectedModelId: "gpt-5.5",
    selectedReasoningLevel: "low",
    harnessExplanation: "harness reason",
    modelExplanation: "",
  }, candidates).ok, false);
});

test("primary recommender failure attempts only paired fallback", async () => {
  const attempted: string[] = [];
  const result = await runCodingHarnessRecommendation({
    payload: buildRequestPayloadForTokenCount({ instruction: "fix" }),
    snapshots: snapshots(),
    candidates: centralCandidates(),
    policy: policy({ standardModelId: "codex:primary", defaultRouteFallbackModelId: "MiniMax-M3" }),
    runRung: async ({ rung }) => {
      attempted.push(rung.modelId);
      throw new Error("failed");
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(attempted, ["codex:primary", "MiniMax-M3"]);
  if (!result.ok) assert.match(result.reason, /No other recommender fallback/);
});

test("primary plus fallback failure blocks launch loudly with no execution model", async () => {
  const result = await runCodingHarnessRecommendation({
    payload: buildRequestPayloadForTokenCount({ instruction: "fix" }),
    snapshots: snapshots(),
    candidates: centralCandidates(),
    policy: policy({ standardModelId: "codex:primary", defaultRouteFallbackModelId: "MiniMax-M3" }),
    runRung: async () => { throw new Error("provider unavailable"); },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /Primary recommender failed/);
    assert.match(result.reason, /Fallback recommender failed/);
    assert.match(result.reason, /No execution model selected/);
  }
});

test("no deterministic execution-model routing remains in normal path", async () => {
  const result = await runCodingHarnessRecommendation({
    payload: buildRequestPayloadForTokenCount({ instruction: "small" }),
    snapshots: snapshots(),
    candidates: centralCandidates(),
    policy: policy({ standardModelId: "codex:router-only", largeContextThresholdTokens: 1_000_000 }),
    runRung: async () => ({
      selectedHarness: "codex_cli",
      selectedModelId: "gpt-5.4",
      selectedReasoningLevel: "low",
      harnessExplanation: "Codex CLI is available.",
      modelExplanation: "The recommender selected gpt-5.4 from authorized candidates.",
      alternatives: [],
    }),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.lane, "default");
    assert.equal(result.recommender.modelId, "codex:router-only");
    assert.equal(result.recommendation.selectedModelId, "gpt-5.4");
  }
});
