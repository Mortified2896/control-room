import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPanelShape,
  classifyLatencyTier,
  costTierBadgeClass,
  costTierBadgeLabel,
  derivePanelConfidence,
  estimatePanelCostTier,
  PanelShapeError,
} from "./recommendation-shape";
import type { RoutingDecisionPanel } from "./routing-decision-panel-types";

const basePanel: RoutingDecisionPanel = {
  contextDecision: {
    recommended: "chat_only",
    explanation: "Conceptual question.",
  },
  executionPackage: {
    model: { recommended: "codex:gpt-5.5", alternatives: ["codex:gpt-5.4-mini"] },
    reasoningLevel: { recommended: "low", supportedValues: ["low", "medium", "high"] },
    harness: { recommended: "normal_chat", alternatives: ["normal_chat", "repo_file_harness"] },
    explanation: "Cheap reasoning on Codex GPT-5.4 Mini.",
  },
  confidence: 0.86,
  costTier: "expensive",
  latencyMs: 13700,
};

test("classifyLatencyTier buckets latencies correctly", () => {
  assert.equal(classifyLatencyTier(500), "fast");
  assert.equal(classifyLatencyTier(1999), "fast");
  assert.equal(classifyLatencyTier(2000), "normal");
  assert.equal(classifyLatencyTier(7999), "normal");
  assert.equal(classifyLatencyTier(8000), "slow");
  assert.equal(classifyLatencyTier(13_700), "slow");
});

test("costTierBadgeLabel returns the expected label for each tier", () => {
  assert.equal(costTierBadgeLabel("standard"), "Standard");
  assert.equal(costTierBadgeLabel("cheap"), "Cheap");
  assert.equal(costTierBadgeLabel("expensive"), "Expensive");
});

test("costTierBadgeClass returns a non-empty Tailwind class for each tier", () => {
  for (const tier of ["standard", "cheap", "expensive"] as const) {
    const cls = costTierBadgeClass(tier);
    assert.ok(cls.length > 0);
    assert.match(cls, /border-/);
  }
});

test("estimatePanelCostTier maps registry tiers to the panel enum", () => {
  const registry = {
    models: [
      { modelId: "codex:gpt-5.5", tier: "expensive" },
      { modelId: "codex:gpt-5.4-mini", tier: "cheap" },
      { modelId: "unknown-model", tier: "unknown" },
    ],
  } as unknown as Parameters<typeof estimatePanelCostTier>[1];
  assert.equal(estimatePanelCostTier("codex:gpt-5.5", registry), "expensive");
  assert.equal(estimatePanelCostTier("codex:gpt-5.4-mini", registry), "cheap");
  assert.equal(estimatePanelCostTier("unknown-model", registry), "standard");
  assert.equal(estimatePanelCostTier("missing-id", registry), "standard");
  assert.equal(estimatePanelCostTier("any-id", null), "standard");
});

test("derivePanelConfidence maps reasoning levels to a 0..1 value", () => {
  const values = ["low", "medium", "high", "xhigh"];
  for (const lvl of values) {
    const c = derivePanelConfidence({ reasoningLevel: lvl, reasoningSupportedValues: values });
    assert.ok(c >= 0 && c <= 1, `confidence out of range for ${lvl}: ${c}`);
  }
  // Unknown reasoning level falls back to the conservative 0.65.
  const c = derivePanelConfidence({
    reasoningLevel: "plaid",
    reasoningSupportedValues: values,
  });
  assert.equal(c, 0.65);
});

test("assertPanelShape accepts a well-formed panel", () => {
  assert.doesNotThrow(() => assertPanelShape(basePanel));
});

test("assertPanelShape rejects a missing context decision", () => {
  const panel = { ...basePanel, contextDecision: undefined as unknown as never };
  assert.throws(() => assertPanelShape(panel), PanelShapeError);
});

test("assertPanelShape rejects an unexpected context decision enum value", () => {
  const panel = {
    ...basePanel,
    contextDecision: {
      recommended: "coding_task" as never,
      explanation: "x",
    },
  };
  assert.throws(() => assertPanelShape(panel), (err: Error) => {
    return err instanceof PanelShapeError && err.field === "contextDecision.recommended";
  });
});

test("assertPanelShape rejects a confidence out of [0,1]", () => {
  const high = { ...basePanel, confidence: 1.5 };
  assert.throws(() => assertPanelShape(high), PanelShapeError);
  const low = { ...basePanel, confidence: -0.1 };
  assert.throws(() => assertPanelShape(low), PanelShapeError);
});

test("assertPanelShape rejects a negative latency", () => {
  const panel = { ...basePanel, latencyMs: -1 };
  assert.throws(() => assertPanelShape(panel), PanelShapeError);
});

test("assertPanelShape rejects an unexpected cost tier", () => {
  const panel = { ...basePanel, costTier: "ridiculous" as never };
  assert.throws(() => assertPanelShape(panel), PanelShapeError);
});

test("assertPanelShape rejects a non-string execution package explanation", () => {
  const panel = {
    ...basePanel,
    executionPackage: {
      ...basePanel.executionPackage,
      explanation: { why: "x" } as unknown as string,
    },
  };
  assert.throws(() => assertPanelShape(panel), PanelShapeError);
});