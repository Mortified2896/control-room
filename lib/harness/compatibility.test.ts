import test from "node:test";
import assert from "node:assert/strict";

import {
  CODEX_CATALOG_MODELS,
  isCodexCatalogModelId,
} from "@/lib/providers/codex-catalog";
import {
  getMiniMaxModels,
  MINIMAX_DEFAULT_MODEL_ID,
} from "@/lib/providers/minimax";
import {
  getValidCodingExecutionPairs,
  getCodingHarnessCandidates,
  harnessSupportsModel,
  resolveReasoningLevelForPair,
  getMiniMaxCliDefaultModelId,
} from "./compatibility";

/**
 * Compatibility resolver tests.
 *
 * The brief calls these out explicitly:
 *
 *   - Codex CLI candidates come ONLY from Codex-catalog rows.
 *   - MiniMax CLI candidates come ONLY from MiniMax-catalog rows.
 *   - Codex CLI never receives MiniMax models.
 *   - MiniMax CLI never receives Codex/OpenAI models.
 *   - OpenCode / Pi produce zero candidates unless explicitly
 *     configured.
 *   - `getValidCodingExecutionPairs` returns only valid pairs.
 *   - `harnessSupportsModel` enforces the harness allowlist.
 *   - `resolveReasoningLevelForPair` coerces out-of-set picks to
 *     the model's documented default option, and force-coerces
 *     anything to `"provider_default"` for MiniMax CLI.
 *
 * The tests probe the catalog directly to confirm the catalog
 * itself obeys the rules; they then exercise the public
 * functions to confirm the resolver surfaces only valid pairs.
 */

test("Codex catalog contains only Codex-targeted rows (no MiniMax ids)", () => {
  for (const row of CODEX_CATALOG_MODELS) {
    assert.ok(
      isCodexCatalogModelId(row.id),
      `Codex catalog row ${row.id} must satisfy the catalog id type guard`,
    );
    assert.notEqual(
      row.id,
      MINIMAX_DEFAULT_MODEL_ID,
      "Codex catalog must never carry MiniMax-M3",
    );
    assert.ok(
      row.supportedExecutionTargets.includes("codex_cli"),
      `Codex catalog row ${row.id} must carry codex_cli in supportedExecutionTargets`,
    );
  }
});

test("MiniMax provider row carries minimax_cli in supportedExecutionTargets", () => {
  const rows = getMiniMaxModels();
  assert.ok(rows.length > 0, "MiniMax provider must surface at least one row");
  for (const row of rows) {
    const targets = row.supportedExecutionTargets ?? ["chat_model", "minimax_cli"];
    assert.ok(
      targets.includes("minimax_cli"),
      `MiniMax provider row ${row.modelId} must carry minimax_cli in supportedExecutionTargets`,
    );
  }
});

test("getValidCodingExecutionPairs returns Codex-only + MiniMax-only rows (no cross-pollination)", async () => {
  const pairs = await getValidCodingExecutionPairs();
  assert.ok(pairs.length > 0, "at least one valid pair must exist");

  // Catalog model ids as a Set<string> for fast membership tests.
  // Using `string` (not the literal catalog id union) so we can
  // test that the resolver never produces pair.modelId values
  // outside the catalog.
  const codexIds = new Set<string>(CODEX_CATALOG_MODELS.map((m) => m.id));
  const minimaxIds = new Set<string>(getMiniMaxModels().map((m) => m.modelId));

  for (const pair of pairs) {
    if (pair.harnessId === "codex_cli") {
      assert.ok(
        codexIds.has(pair.modelId),
        `Codex CLI pair must reference a Codex catalog id; got ${pair.modelId}`,
      );
      assert.ok(
        !minimaxIds.has(pair.modelId),
        `Codex CLI must NEVER receive a MiniMax model id; got ${pair.modelId}`,
      );
    } else if (pair.harnessId === "minimax_cli") {
      assert.ok(
        minimaxIds.has(pair.modelId),
        `MiniMax CLI pair must reference a MiniMax provider id; got ${pair.modelId}`,
      );
      assert.ok(
        !codexIds.has(pair.modelId),
        `MiniMax CLI must NEVER receive a Codex catalog id; got ${pair.modelId}`,
      );
      // MiniMax CLI always uses provider_default regardless of
      // the catalog capability — see
      // resolveReasoningLevelForPair docstring.
      assert.equal(pair.selectedReasoningLevel, "provider_default");
      assert.deepEqual([...pair.supportedReasoningLevels], ["provider_default"]);
    } else {
      assert.fail(`unexpected harnessId in pair: ${String(pair.harnessId)}`);
    }
  }
});

test("Codex CLI pair carries harness-specific reasoning levels", async () => {
  const pairs = await getValidCodingExecutionPairs();
  const codexPairs = pairs.filter((p) => p.harnessId === "codex_cli");
  assert.ok(codexPairs.length > 0, "at least one Codex CLI pair must exist");
  for (const pair of codexPairs) {
    assert.ok(
      pair.supportedReasoningLevels.length > 0,
      `Codex pair ${pair.modelId} must surface reasoning levels`,
    );
    // The picker always picks a value within the model's set.
    assert.ok(
      pair.supportedReasoningLevels.includes(pair.selectedReasoningLevel),
      `Codex pair ${pair.modelId}: selected level ${pair.selectedReasoningLevel} not in supported set`,
    );
  }
});

test("getCodingHarnessCandidates filters to a single harness", async () => {
  const codex = await getCodingHarnessCandidates("codex_cli");
  assert.ok(codex.length > 0, "Codex CLI candidates must exist");
  for (const pair of codex) {
    assert.equal(pair.harnessId, "codex_cli");
  }
  const minimax = await getCodingHarnessCandidates("minimax_cli");
  assert.ok(minimax.length > 0, "MiniMax CLI candidates must exist");
  for (const pair of minimax) {
    assert.equal(pair.harnessId, "minimax_cli");
  }
});

test("harnessSupportsModel enforces the allowlist (Codex vs MiniMax)", () => {
  // Codex CLI accepts Codex catalog ids (bare or prefixed).
  assert.equal(harnessSupportsModel("codex_cli", "gpt-5.4-mini"), true);
  assert.equal(harnessSupportsModel("codex_cli", "codex:gpt-5.4-mini"), true);
  // Codex CLI rejects MiniMax models.
  assert.equal(harnessSupportsModel("codex_cli", "MiniMax-M3"), false);
  assert.equal(harnessSupportsModel("codex_cli", "minimax:MiniMax-M3"), false);
  // MiniMax CLI accepts MiniMax-M3 (bare or prefixed) but not
  // any Codex/OpenAI model.
  assert.equal(harnessSupportsModel("minimax_cli", "MiniMax-M3"), true);
  assert.equal(harnessSupportsModel("minimax_cli", "minimax:MiniMax-M3"), true);
  assert.equal(harnessSupportsModel("minimax_cli", "gpt-5.4-mini"), false);
  assert.equal(harnessSupportsModel("minimax_cli", "codex:gpt-5.5"), false);
  // OpenAI API chat-only models are never accepted by either
  // harness (no allowlist entry).
  assert.equal(harnessSupportsModel("codex_cli", "gpt-4o-mini"), false);
  assert.equal(harnessSupportsModel("minimax_cli", "gpt-4o-mini"), false);
  // Unknown harness ids (OpenCode / Pi until registered)
  // resolve to false.
  assert.equal(harnessSupportsModel("opencode_cli", "MiniMax-M3"), false);
  assert.equal(harnessSupportsModel("pi_cli", "gpt-5.4-mini"), false);
});

test("resolveReasoningLevelForPair coerces Codex picks to the model's documented set", () => {
  // In-set pick is honoured.
  const inSet = resolveReasoningLevelForPair("codex_cli", "gpt-5.4-mini", "medium");
  assert.equal(inSet.selectedReasoningLevel, "medium");
  assert.ok(inSet.supportedReasoningLevels.includes("medium"));
  // Out-of-set pick falls back to the model's default option
  // ("low" for the mini tier).
  const outOfSet = resolveReasoningLevelForPair("codex_cli", "gpt-5.4-mini", "xhigh");
  assert.equal(outOfSet.selectedReasoningLevel, "low");
  // No preference at all → default option.
  const none = resolveReasoningLevelForPair("codex_cli", "gpt-5.4-mini");
  assert.equal(none.selectedReasoningLevel, "low");
});

test("resolveReasoningLevelForPair force-coerces MiniMax CLI to provider_default", () => {
  // Even when the caller passes a Codex-style effort level, the
  // MiniMax CLI surface only accepts `provider_default`. The
  // helper enforces this so no upstream caller can ship a fake
  // reasoning knob to the MiniMax runner.
  const forced = resolveReasoningLevelForPair("minimax_cli", "MiniMax-M3", "xhigh");
  assert.equal(forced.selectedReasoningLevel, "provider_default");
  const noPref = resolveReasoningLevelForPair("minimax_cli", "MiniMax-M3");
  assert.equal(noPref.selectedReasoningLevel, "provider_default");
  // The supported set is reduced to the single value the CLI
  // accepts.
  assert.deepEqual([...forced.supportedReasoningLevels], ["provider_default"]);
});

test("resolveReasoningLevelForPair returns provider_default for an unknown model id", () => {
  // Defensive: when the catalog row is missing, we still want
  // a deterministic answer for the chat composer (never
  // undefined).
  const fallback = resolveReasoningLevelForPair("minimax_cli", "MiniMax-M9");
  assert.equal(fallback.selectedReasoningLevel, "provider_default");
});

test("getMiniMaxCliDefaultModelId returns the canonical MiniMax M3 id", () => {
  assert.equal(getMiniMaxCliDefaultModelId(), "MiniMax-M3");
  assert.equal(getMiniMaxCliDefaultModelId(), MINIMAX_DEFAULT_MODEL_ID);
});