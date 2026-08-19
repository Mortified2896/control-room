import test from "node:test";
import assert from "node:assert/strict";

import { listRouterAllowedPool, resolveModel } from "./index";

test("resolveModel treats codex:gpt-5.5 as subscription-backed", () => {
  const resolved = resolveModel("codex:gpt-5.5");
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.resolved.providerId, "codex");
    assert.equal(resolved.resolved.modelId, "codex:gpt-5.5");
    assert.equal(resolved.resolved.billingSource, "subscription");
  }
});

test("resolveModel does not advertise legacy codex:gpt-5.5-small", () => {
  const resolved = resolveModel("codex:gpt-5.5-small");
  assert.equal(resolved.ok, false);
  if (!resolved.ok) assert.equal(resolved.error.kind, "unknown_model");
});

test("listRouterAllowedPool includes all Codex catalog models with all supported reasoning levels", () => {
  // Codex subscription models must appear in the pool so the recommender
  // can pick them. The tier filter still applies (allowExpensive=true).
  const pool = listRouterAllowedPool(true);
  const codexPool = pool.filter((e) => e.modelId.startsWith("codex:"));

  // gpt-5.5 — 6 effort levels
  const gpt55 = codexPool.filter((e) => e.modelId === "codex:gpt-5.5");
  assert.ok(gpt55.length >= 6, `expected ≥6 gpt-5.5 combos, got ${gpt55.length}`);
  const gpt55Levels = new Set(gpt55.map((e) => e.reasoningLevel));
  assert.ok(gpt55Levels.has("none"), "gpt-5.5 none missing from pool");
  assert.ok(gpt55Levels.has("minimal"), "gpt-5.5 minimal missing from pool");
  assert.ok(gpt55Levels.has("low"), "gpt-5.5 low missing from pool");
  assert.ok(gpt55Levels.has("medium"), "gpt-5.5 medium missing from pool");
  assert.ok(gpt55Levels.has("high"), "gpt-5.5 high missing from pool");
  assert.ok(gpt55Levels.has("xhigh"), "gpt-5.5 xhigh missing from pool");

  // gpt-5.4-mini — 4 effort levels (no xhigh)
  const gpt54mini = codexPool.filter((e) => e.modelId === "codex:gpt-5.4-mini");
  assert.ok(gpt54mini.length >= 4, `expected ≥4 gpt-5.4-mini combos, got ${gpt54mini.length}`);
  const gpt54miniLevels = new Set(gpt54mini.map((e) => e.reasoningLevel));
  assert.ok(gpt54miniLevels.has("none"), "gpt-5.4-mini none missing from pool");
  assert.ok(gpt54miniLevels.has("low"), "gpt-5.4-mini low missing from pool");
  assert.ok(gpt54miniLevels.has("medium"), "gpt-5.4-mini medium missing from pool");
  assert.ok(gpt54miniLevels.has("high"), "gpt-5.4-mini high missing from pool");
  assert.ok(!gpt54miniLevels.has("xhigh"), "gpt-5.4-mini should NOT have xhigh in pool");

  // gpt-5.3-codex-spark — 1 effort level (low)
  const spark = codexPool.filter((e) => e.modelId === "codex:gpt-5.3-codex-spark");
  assert.ok(spark.length >= 1, `expected ≥1 gpt-5.3-codex-spark combos, got ${spark.length}`);
  const sparkLevels = new Set(spark.map((e) => e.reasoningLevel));
  assert.ok(sparkLevels.has("low"), "gpt-5.3-codex-spark low missing from pool");
});

test("listRouterAllowedPool excludes expensive Codex models when allowExpensive=false", () => {
  const pool = listRouterAllowedPool(false);
  const expensiveCodex = pool.filter(
    (e) => e.modelId.startsWith("codex:") && e.tier === "expensive",
  );
  assert.equal(expensiveCodex.length, 0, "expensive Codex models should be excluded when allowExpensive=false");

  // Cheap Codex models should still be present
  const cheapCodex = pool.filter(
    (e) => e.modelId.startsWith("codex:") && e.tier !== "expensive",
  );
  assert.ok(cheapCodex.length > 0, "cheap Codex models should be present even when allowExpensive=false");
});
