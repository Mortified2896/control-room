import assert from "node:assert/strict";
import test from "node:test";

import { fakeRouterRecommendation } from "./fake-llm.ts";
import type { RouterAllowlistEntry } from "@/lib/providers/types";

const POOL: ReadonlyArray<RouterAllowlistEntry> = [
  { modelId: "gpt-5.4-mini", reasoningLevel: "low", tier: "cheap" },
  { modelId: "gpt-5.4-mini", reasoningLevel: "medium", tier: "cheap" },
  { modelId: "gpt-5.5", reasoningLevel: "low", tier: "expensive" },
  { modelId: "gpt-5.5", reasoningLevel: "medium", tier: "expensive" },
  { modelId: "gpt-5.5", reasoningLevel: "high", tier: "expensive" },
];

test("fakeRouterRecommendation picks low for trivial prompts", () => {
  const r = fakeRouterRecommendation({
    userPrompt: "What is 2 + 2?",
    allowlist: POOL,
  });
  assert.equal(r.recommended_model, "gpt-5.4-mini");
  assert.equal(r.recommended_reasoning_level, "low");
  assert.ok(r.confidence > 0 && r.confidence <= 1);
});

test("fakeRouterRecommendation picks medium for code prompts", () => {
  const r = fakeRouterRecommendation({
    userPrompt: "Please implement a function that flattens a list.",
    allowlist: POOL,
  });
  assert.equal(r.recommended_reasoning_level, "medium");
});

test("fakeRouterRecommendation picks high for debugging prompts", () => {
  const r = fakeRouterRecommendation({
    userPrompt: "I'm debugging a stack trace from a production crash.",
    allowlist: POOL,
  });
  assert.equal(r.recommended_reasoning_level, "high");
});

test("fakeRouterRecommendation respects the allowlist when no high option is available", () => {
  const cheapOnly: ReadonlyArray<RouterAllowlistEntry> = [
    { modelId: "gpt-5.4-mini", reasoningLevel: "low", tier: "cheap" },
    { modelId: "gpt-5.4-mini", reasoningLevel: "medium", tier: "cheap" },
  ];
  const r = fakeRouterRecommendation({
    userPrompt: "I need a deep refactor.",
    allowlist: cheapOnly,
  });
  assert.equal(r.recommended_model, "gpt-5.4-mini");
  assert.notEqual(r.recommended_reasoning_level, "high");
});

test("fakeRouterRecommendation returns an obviously-invalid marker for an empty pool", () => {
  const r = fakeRouterRecommendation({ userPrompt: "hi", allowlist: [] });
  assert.equal(r.recommended_model, "__no_allowlist__");
});
