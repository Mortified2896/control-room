import assert from "node:assert/strict";
import test from "node:test";

import {
  applyBudgetGuard,
  estimateCostUsd,
  isInAllowedPool,
  pickFallback,
  resolveAllowedPool,
  validateRouterOutput,
} from "./policy.ts";
import { DEFAULT_ROUTER_SETTINGS, parseRouterSettings } from "./schema.ts";

const POOL = resolveAllowedPool(DEFAULT_ROUTER_SETTINGS, 0);

test("resolveAllowedPool excludes expensive tier when allowExpensiveModels=false", () => {
  const pool = resolveAllowedPool(DEFAULT_ROUTER_SETTINGS, 0);
  assert.equal(
    pool.some((e) => e.tier === "expensive"),
    false,
  );
  assert.equal(
    pool.some((e) => e.modelId === "gpt-5.4-mini"),
    true,
  );
});

test("resolveAllowedPool includes expensive tier when allowExpensiveModels=true", () => {
  const settings = { ...DEFAULT_ROUTER_SETTINGS, allowExpensiveModels: true };
  const pool = resolveAllowedPool(settings, 0);
  assert.equal(
    pool.some((e) => e.modelId === "gpt-5.5"),
    true,
  );
});

test("resolveAllowedPool auto-excludes expensive on long prompt unless allowed", () => {
  const settings = { ...DEFAULT_ROUTER_SETTINGS, allowExpensiveModels: true };
  const short = resolveAllowedPool(settings, 100);
  assert.equal(
    short.some((e) => e.tier === "expensive"),
    true,
  );
  const long = resolveAllowedPool(settings, DEFAULT_ROUTER_SETTINGS.longPromptThresholdChars + 1);
  assert.equal(
    long.some((e) => e.tier === "expensive"),
    false,
  );
});

test("resolveAllowedPool keeps expensive on long prompt when explicitly allowed", () => {
  const settings = {
    ...DEFAULT_ROUTER_SETTINGS,
    allowExpensiveModels: true,
    allowLongPromptWhenExpensive: true,
  };
  const pool = resolveAllowedPool(settings, 100_000);
  assert.equal(
    pool.some((e) => e.tier === "expensive"),
    true,
  );
});

test("isInAllowedPool is true for a pool member", () => {
  const member = POOL[0];
  assert.equal(member !== undefined, true);
  if (!member) return;
  assert.equal(
    isInAllowedPool({ modelId: member.modelId, reasoningLevel: member.reasoningLevel }, POOL),
    true,
  );
});

test("isInAllowedPool is false for a non-pool member", () => {
  assert.equal(isInAllowedPool({ modelId: "gpt-5.5", reasoningLevel: "high" }, POOL), false);
  assert.equal(isInAllowedPool({ modelId: "no-such-model", reasoningLevel: "low" }, POOL), false);
});

test("applyBudgetGuard keeps B under budget", () => {
  const sideA = { modelId: "gpt-5.4-mini", reasoningLevel: "low" as const };
  const sideB = { modelId: "gpt-5.4-mini", reasoningLevel: "low" as const };
  const decision = applyBudgetGuard(sideA, sideB, DEFAULT_ROUTER_SETTINGS, 100);
  assert.equal(decision.keepB, true);
  if (decision.keepB) {
    assert.deepEqual(decision.combo, sideB);
  }
});

test("applyBudgetGuard rejects B when combined A/B cost exceeds max", () => {
  const settings = { ...DEFAULT_ROUTER_SETTINGS, maxCostPerAbRunUsd: 0.001 };
  const sideA = { modelId: "gpt-5.5", reasoningLevel: "medium" as const };
  const sideB = { modelId: "gpt-5.5", reasoningLevel: "low" as const };
  const decision = applyBudgetGuard(sideA, sideB, settings, 100);
  assert.equal(decision.keepB, false);
  if (!decision.keepB) {
    assert.match(decision.reason, /exceeds max/);
  }
});

test("applyBudgetGuard rejects B when recommendation itself exceeds max", () => {
  const settings = { ...DEFAULT_ROUTER_SETTINGS, maxCostPerRecommendationUsd: 0.0005 };
  const sideA = { modelId: "gpt-5.4-mini", reasoningLevel: "low" as const };
  const sideB = { modelId: "gpt-5.5", reasoningLevel: "low" as const };
  const decision = applyBudgetGuard(sideA, sideB, settings, 100);
  assert.equal(decision.keepB, false);
  if (!decision.keepB) {
    assert.match(decision.reason, /recommendation/);
  }
});

test("validateRouterOutput accepts a well-formed in-pool recommendation", () => {
  const member = POOL[0];
  assert.ok(member);
  if (!member) return;
  const raw = {
    recommended_model: member.modelId,
    recommended_reasoning_level: member.reasoningLevel,
    confidence: 0.7,
    task_type: "coding",
    short_reason: "Coding benefits from a slightly higher reasoning level.",
  };
  const result = validateRouterOutput(raw, POOL);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.recommendedModel, member.modelId);
    assert.equal(result.value.recommendedReasoningLevel, member.reasoningLevel);
  }
});

test("validateRouterOutput rejects unknown model id", () => {
  const raw = {
    recommended_model: "gpt-not-a-real-model",
    recommended_reasoning_level: "low",
    confidence: 0.5,
    task_type: "coding",
    short_reason: "Choosing a non-existent model.",
  };
  const result = validateRouterOutput(raw, POOL);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /combo not in allowlist|unknown model/);
  }
});

test("validateRouterOutput rejects disallowed reasoning level", () => {
  // gpt-5.4-mini only supports low/medium — "high" is not allowed.
  const raw = {
    recommended_model: "gpt-5.4-mini",
    recommended_reasoning_level: "high",
    confidence: 0.5,
    task_type: "coding",
    short_reason: "Asking for high reasoning on a model that does not support it.",
  };
  const result = validateRouterOutput(raw, POOL);
  assert.equal(result.ok, false);
});

test("validateRouterOutput rejects out-of-range confidence", () => {
  const raw = {
    recommended_model: "gpt-5.4-mini",
    recommended_reasoning_level: "low",
    confidence: 1.4,
    task_type: "coding",
    short_reason: "Confidence above 1 is not allowed.",
  };
  const result = validateRouterOutput(raw, POOL);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /confidence/);
  }
});

test("validateRouterOutput rejects disallowed task_type", () => {
  const raw = {
    recommended_model: "gpt-5.4-mini",
    recommended_reasoning_level: "low",
    confidence: 0.5,
    task_type: "not-a-task",
    short_reason: "Task type is not in the allowed list.",
  };
  const result = validateRouterOutput(raw, POOL);
  assert.equal(result.ok, false);
});

test("validateRouterOutput rejects empty short_reason", () => {
  const raw = {
    recommended_model: "gpt-5.4-mini",
    recommended_reasoning_level: "low",
    confidence: 0.5,
    task_type: "coding",
    short_reason: "",
  };
  const result = validateRouterOutput(raw, POOL);
  assert.equal(result.ok, false);
});

test("pickFallback returns the cheapest entry in the pool", () => {
  const fallback = pickFallback(POOL);
  // gpt-5.4-mini low = $0.001 (cheapest in the default pool)
  assert.equal(fallback.modelId, "gpt-5.4-mini");
  assert.equal(fallback.reasoningLevel, "low");
});

test("pickFallback is deterministic on a non-empty pool", () => {
  const a = pickFallback(POOL);
  const b = pickFallback(POOL);
  assert.deepEqual(a, b);
});

test("pickFallback returns a safe default when pool is empty", () => {
  const fallback = pickFallback([]);
  assert.equal(fallback.modelId, "gpt-5.4-mini");
  assert.equal(fallback.reasoningLevel, "low");
});

test("estimateCostUsd returns a non-negative number for known combos", () => {
  const cost = estimateCostUsd({ modelId: "gpt-5.4-mini", reasoningLevel: "low" });
  assert.ok(cost >= 0);
});

test("estimateCostUsd returns 0 for unknown model ids", () => {
  const cost = estimateCostUsd({ modelId: "unknown", reasoningLevel: "low" });
  assert.equal(cost, 0);
});

test("parseRouterSettings rejects invalid shape", () => {
  assert.throws(() => parseRouterSettings(null));
  assert.throws(() => parseRouterSettings("nope"));
  assert.throws(() => parseRouterSettings({ abEnabled: "yes" }));
});

test("parseRouterSettings applies overrides on a valid payload", () => {
  const parsed = parseRouterSettings({ allowExpensiveModels: true, maxCostPerAbRunUsd: 1.5 });
  assert.equal(parsed.allowExpensiveModels, true);
  assert.equal(parsed.maxCostPerAbRunUsd, 1.5);
  // Unspecified fields keep their default.
  assert.equal(parsed.routerModelId, DEFAULT_ROUTER_SETTINGS.routerModelId);
});
