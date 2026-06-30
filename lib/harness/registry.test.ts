import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HARNESS_REGISTRY,
  getHarnessEntry,
  stripHarnessModelPrefix,
  harnessSupportsModel,
} from "./registry";

test("HARNESS_REGISTRY has Codex and MiniMax entries with the brief's expected shape", () => {
  const codex = HARNESS_REGISTRY.find((h) => h.id === "codex_cli");
  const minimax = HARNESS_REGISTRY.find((h) => h.id === "minimax_cli");
  assert.ok(codex, "codex_cli must be registered");
  assert.ok(minimax, "minimax_cli must be registered");
  assert.equal(codex!.providerPath, "Codex CLI / ChatGPT login");
  assert.equal(minimax!.providerPath, "MiniMax CLI / MiniMax token plan");
  assert.equal(codex!.supportsReasoningLevels, true);
  assert.equal(minimax!.supportsReasoningLevels, false);
  assert.equal(minimax!.defaultReasoningLevel, "provider_default");
});

test("getHarnessEntry resolves by id and rejects unknown ids", () => {
  assert.equal(getHarnessEntry("codex_cli").id, "codex_cli");
  assert.equal(getHarnessEntry("minimax_cli").id, "minimax_cli");
  assert.throws(() => getHarnessEntry("openai" as Parameters<typeof getHarnessEntry>[0]));
});

test("stripHarnessModelPrefix strips the harness-specific prefix", () => {
  assert.equal(stripHarnessModelPrefix("codex:gpt-5.4-mini"), "gpt-5.4-mini");
  assert.equal(stripHarnessModelPrefix("minimax:MiniMax-M3"), "MiniMax-M3");
  assert.equal(stripHarnessModelPrefix("gpt-5.4-mini"), "gpt-5.4-mini");
});

test("harnessSupportsModel enforces the harness allowlist", () => {
  const codex = HARNESS_REGISTRY.find((h) => h.id === "codex_cli")!;
  const minimax = HARNESS_REGISTRY.find((h) => h.id === "minimax_cli")!;
  // Codex accepts only Codex catalog ids (bare form).
  assert.equal(harnessSupportsModel(codex, "gpt-5.4-mini"), true);
  assert.equal(harnessSupportsModel(codex, "MiniMax-M3"), false);
  // MiniMax accepts only the M3 id (bare form).
  assert.equal(harnessSupportsModel(minimax, "MiniMax-M3"), true);
  assert.equal(harnessSupportsModel(minimax, "gpt-5.4-mini"), false);
});
