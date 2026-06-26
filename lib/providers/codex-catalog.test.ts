import test from "node:test";
import assert from "node:assert/strict";

import {
  CODEX_CATALOG_MODELS,
  CODEX_DEFAULT_MODEL_ID,
  isCodexCatalogModelId,
} from "./codex-catalog";

test("Codex catalog includes refreshed static model set", () => {
  const ids = CODEX_CATALOG_MODELS.map((m) => m.id);
  assert.deepEqual(ids, ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"]);
  assert.equal(CODEX_DEFAULT_MODEL_ID, "gpt-5.4-mini");
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
