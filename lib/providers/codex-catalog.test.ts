import test from "node:test";
import assert from "node:assert/strict";

import {
  CODEX_CATALOG_MODELS,
  CODEX_DEFAULT_MODEL_ID,
  isCodexCatalogModelId,
} from "./codex-catalog";
import { getEffectiveReasoningLevels } from "./capability";

test("Codex catalog includes refreshed static model set", () => {
  const ids = CODEX_CATALOG_MODELS.map((m) => m.id);
  assert.deepEqual(ids, ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"]);
  assert.equal(CODEX_DEFAULT_MODEL_ID, "gpt-5.5");
  assert.equal(isCodexCatalogModelId("gpt-5.5-small"), false);
});

test("Codex catalog is CLI-backed and never requires OPENAI_API_KEY", () => {
  for (const model of CODEX_CATALOG_MODELS) {
    assert.equal(model.transport, "codex-cli");
    assert.equal(model.source, "codex_catalog");
    assert.equal(model.discoveryType, "static_catalog");
    assert.equal(model.requiresApiKey, false);
  }
});

test("Codex catalog rejects unknown model ids", () => {
  assert.equal(isCodexCatalogModelId("gpt-5.4"), true);
  assert.equal(isCodexCatalogModelId("not-a-codex-model"), false);
});

test("Codex Spark is marked as plan-gated", () => {
  const spark = CODEX_CATALOG_MODELS.find((m) => m.id === "gpt-5.3-codex-spark");
  assert.ok(spark);
  assert.equal(spark.mayBePlanGated, true);
});

test('Codex catalog is NOT hardcoded to reasoningLevels: ["low"] — each model advertises its real set', () => {
  // Regression for the brief: the registry used to lie about Codex
  // capability by hardcoding `reasoningLevels: ["low"]`. Each catalog
  // entry must now carry an honest reasoning capability with
  // provider-native option values.
  for (const model of CODEX_CATALOG_MODELS) {
    assert.ok(model.reasoningCapability, `${model.id} must expose a reasoningCapability`);
    assert.equal(model.reasoningCapability.kind, "effort_levels");
  }
  const byId = new Map(CODEX_CATALOG_MODELS.map((m) => [m.id, m] as const));
  // gpt-5.5 / gpt-5.4 advertise the FULL provider-native set
  // (none, minimal, low, medium, high, xhigh) — including the
  // non-legacy `none`, `minimal`, and `xhigh` values the previous
  // narrow enum could not represent.
  for (const id of ["gpt-5.5", "gpt-5.4"] as const) {
    const cap = byId.get(id)?.reasoningCapability;
    assert.equal(cap?.control, "supported");
    assert.deepEqual(getEffectiveReasoningLevels(cap!), [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  }
  // gpt-5.4-mini is cheap-tier — no `xhigh` / `minimal`; `none` is
  // still surfaced literally.
  const mini = byId.get("gpt-5.4-mini")?.reasoningCapability;
  assert.equal(mini?.control, "supported");
  assert.deepEqual(getEffectiveReasoningLevels(mini!), ["none", "low", "medium", "high"]);
  // gpt-5.3-codex-spark is research-preview — control is
  // model_dependent and the conservative advertised set is ["low"].
  const spark = byId.get("gpt-5.3-codex-spark")?.reasoningCapability;
  assert.equal(spark?.control, "model_dependent");
  assert.deepEqual(getEffectiveReasoningLevels(spark!), ["low"]);
});
