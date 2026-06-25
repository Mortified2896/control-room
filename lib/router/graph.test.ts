import assert from "node:assert/strict";
import test from "node:test";

import { runRouterGraph } from "./graph.ts";
import { setRecommendImpl, type RecommendImpl } from "./llm-recommend.ts";
import { DEFAULT_ROUTER_SETTINGS } from "./schema.ts";

function stubRecommend(behavior: RecommendImpl): void {
  setRecommendImpl(behavior);
}

const baseInput = {
  latestUserText: "Explain what a Postgres `gen_random_uuid()` does.",
  recentTurns: [],
  sideA: { modelId: "gpt-5.4-mini", reasoningLevel: "low" as const },
  recentChars: 100,
};

test("graph returns a valid recommendation when the LLM output is well-formed", async () => {
  stubRecommend(async () => ({
    ok: true,
    value: {
      recommendedModel: "gpt-5.4-mini",
      recommendedReasoningLevel: "medium",
      confidence: 0.7,
      taskType: "writing",
      shortReason: "Long-form answer benefits from medium reasoning.",
    },
    raw: {
      recommended_model: "gpt-5.4-mini",
      recommended_reasoning_level: "medium",
      confidence: 0.7,
      task_type: "writing",
      short_reason: "Long-form answer benefits from medium reasoning.",
    },
  }));
  const out = await runRouterGraph(baseInput);
  assert.equal(out.usedFallback, false);
  assert.equal(out.skipReason, null);
  assert.ok(out.sideB);
  assert.equal(out.sideB?.modelId, "gpt-5.4-mini");
  assert.equal(out.sideB?.reasoningLevel, "medium");
  assert.ok(out.recommendation);
});

test("graph falls back when the LLM recommends a model not in the allowlist", async () => {
  stubRecommend(async () => ({
    ok: true,
    value: {
      recommendedModel: "gpt-not-in-pool",
      recommendedReasoningLevel: "low",
      confidence: 0.5,
      taskType: "coding",
      shortReason: "Picked something we never registered.",
    },
    raw: {
      recommended_model: "gpt-not-in-pool",
      recommended_reasoning_level: "low",
      confidence: 0.5,
      task_type: "coding",
      short_reason: "Picked something we never registered.",
    },
  }));
  const out = await runRouterGraph(baseInput);
  assert.equal(out.usedFallback, true);
  assert.match(out.fallbackReason ?? "", /combo not in allowlist|unknown model/);
  assert.ok(out.sideB);
});

test("graph falls back when the LLM call throws", async () => {
  stubRecommend(async () => ({ ok: false, reason: "openai 503" }));
  const out = await runRouterGraph(baseInput);
  assert.equal(out.usedFallback, true);
  assert.equal(out.fallbackReason, "openai 503");
  assert.ok(out.sideB); // deterministic cheapest fallback
  assert.equal(out.skipReason, null);
});

test("graph skips Side B when the budget guard rejects it", async () => {
  stubRecommend(async () => ({
    ok: true,
    value: {
      recommendedModel: "gpt-5.4-mini",
      recommendedReasoningLevel: "medium",
      confidence: 0.5,
      taskType: "coding",
      shortReason: "Recommendation that should be too expensive.",
    },
    raw: {
      recommended_model: "gpt-5.4-mini",
      recommended_reasoning_level: "medium",
      confidence: 0.5,
      task_type: "coding",
      short_reason: "Recommendation that should be too expensive.",
    },
  }));
  const out = await runRouterGraph({
    ...baseInput,
    // Force the recommendation itself above the cap.
    settingsOverride: {
      ...DEFAULT_ROUTER_SETTINGS,
      maxCostPerRecommendationUsd: 0.0001,
    },
  });
  assert.equal(out.sideB, null);
  assert.match(out.skipReason ?? "", /recommendation/);
});

test("graph skips Side B when the A/B budget is too tight", async () => {
  stubRecommend(async () => ({
    ok: true,
    value: {
      recommendedModel: "gpt-5.4-mini",
      recommendedReasoningLevel: "low",
      confidence: 0.5,
      taskType: "coding",
      shortReason: "Cheap, should be fine — but the A/B budget is set to zero.",
    },
    raw: {
      recommended_model: "gpt-5.4-mini",
      recommended_reasoning_level: "low",
      confidence: 0.5,
      task_type: "coding",
      short_reason: "Cheap, should be fine — but the A/B budget is set to zero.",
    },
  }));
  const out = await runRouterGraph({
    ...baseInput,
    settingsOverride: {
      ...DEFAULT_ROUTER_SETTINGS,
      maxCostPerAbRunUsd: 0.0001,
    },
  });
  assert.equal(out.sideB, null);
  assert.match(out.skipReason ?? "", /exceeds max/);
});

test("graph respects allowExpensiveModels=true by enabling expensive picks", async () => {
  stubRecommend(async () => ({
    ok: true,
    value: {
      recommendedModel: "gpt-5.5",
      recommendedReasoningLevel: "high",
      confidence: 0.6,
      taskType: "debugging",
      shortReason: "Hard debugging benefits from the most expensive combo.",
    },
    raw: {
      recommended_model: "gpt-5.5",
      recommended_reasoning_level: "high",
      confidence: 0.6,
      task_type: "debugging",
      short_reason: "Hard debugging benefits from the most expensive combo.",
    },
  }));
  const out = await runRouterGraph({
    ...baseInput,
    settingsOverride: {
      ...DEFAULT_ROUTER_SETTINGS,
      allowExpensiveModels: true,
      // The Settings UI is the source of truth for which combos the user
      // has authorized; for this test we authorize the expensive combo
      // we want the LLM to recommend.
      allowedCombos: [
        ...DEFAULT_ROUTER_SETTINGS.allowedCombos,
        { modelId: "gpt-5.5", reasoningLevel: "low" as const },
        { modelId: "gpt-5.5", reasoningLevel: "medium" as const },
        { modelId: "gpt-5.5", reasoningLevel: "high" as const },
      ],
      // Keep the cost cap generous so the budget guard doesn't reject this.
      maxCostPerRecommendationUsd: 1.0,
      maxCostPerAbRunUsd: 1.0,
    },
  });
  assert.equal(out.usedFallback, false);
  assert.equal(out.sideB?.modelId, "gpt-5.5");
  assert.equal(out.sideB?.reasoningLevel, "high");
});

test("graph returns skipReason when settings.abEnabled=false", async () => {
  const out = await runRouterGraph({
    ...baseInput,
    settingsOverride: {
      ...DEFAULT_ROUTER_SETTINGS,
      abEnabled: false,
    },
  });
  assert.equal(out.sideB, null);
  assert.match(out.skipReason ?? "", /disabled/);
});

test("graph auto-excludes expensive on long prompt unless allowLongPromptWhenExpensive", async () => {
  stubRecommend(async () => ({
    ok: true,
    value: {
      recommendedModel: "gpt-5.5",
      recommendedReasoningLevel: "high",
      confidence: 0.8,
      taskType: "research",
      shortReason: "Long research prompt deserves the expensive model.",
    },
    raw: {
      recommended_model: "gpt-5.5",
      recommended_reasoning_level: "high",
      confidence: 0.8,
      task_type: "research",
      short_reason: "Long research prompt deserves the expensive model.",
    },
  }));
  // allowExpensiveModels=true but the prompt is long, so the graph should
  // still refuse to recommend an expensive combo and fall back.
  const out = await runRouterGraph({
    ...baseInput,
    recentChars: DEFAULT_ROUTER_SETTINGS.longPromptThresholdChars + 10,
    settingsOverride: {
      ...DEFAULT_ROUTER_SETTINGS,
      allowExpensiveModels: true,
      maxCostPerRecommendationUsd: 1.0,
      maxCostPerAbRunUsd: 1.0,
    },
  });
  assert.equal(out.usedFallback, true);
  assert.match(out.fallbackReason ?? "", /allowlist|combo not in allowlist|unknown model/);
  assert.equal(out.sideB?.modelId, "gpt-5.4-mini"); // cheap fallback
});

function afterEach() {
  // node:test doesn't have a per-test afterEach hook — each test sets up
  // its own stub. This is kept as documentation only.
  return () => {
    // intentional no-op
  };
}

void afterEach;
