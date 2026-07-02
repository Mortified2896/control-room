import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildExtractResult,
  detectProviderFromLabels,
  normalizeCodexRemaining,
  normalizeMiniMaxRemaining,
  parseSnapshotFromForm,
} from "./screenshot-parser";

test("detectProviderFromLabels — empty input returns unknown/none", () => {
  const result = detectProviderFromLabels({ filename: "" });
  assert.equal(result.detectedProvider, "unknown");
  assert.equal(result.providerConfidence, "none");
  assert.equal(result.minimaxHits, 0);
  assert.equal(result.codexHits, 0);
});

test("detectProviderFromLabels — MiniMax filename with one label is low confidence", () => {
  const result = detectProviderFromLabels({ filename: "minimax-5h-limit.png" });
  assert.equal(result.detectedProvider, "minimax");
  assert.equal(result.providerConfidence, "low");
  assert.equal(result.minimaxHits, 1);
});

test("detectProviderFromLabels — MiniMax filename with multiple labels is high confidence", () => {
  const result = detectProviderFromLabels({
    filename: "minimax-Plan-Usage-Token-Plan-Monthly-Plus-5h-limit-Weekly-limit.png",
  });
  assert.equal(result.detectedProvider, "minimax");
  assert.equal(result.providerConfidence, "high");
  assert.ok(result.minimaxHits >= 2);
});

test("detectProviderFromLabels — Codex filename with multiple labels is high confidence", () => {
  const result = detectProviderFromLabels({
    filename: "codex-Balance-Credits-remaining-Weekly-usage-limit.png",
  });
  assert.equal(result.detectedProvider, "codex");
  assert.equal(result.providerConfidence, "high");
});

test("detectProviderFromLabels — explicit providerId overrides heuristic", () => {
  const result = detectProviderFromLabels({
    filename: "codex-Balance.png",
    explicitProviderId: "minimax",
  });
  assert.equal(result.detectedProvider, "minimax");
});

test("detectProviderFromLabels — tied hits fall back to unknown/low", () => {
  const result = detectProviderFromLabels({
    filename: "Plan Usage Balance.png", // 1 MiniMax + 1 Codex hit
  });
  assert.equal(result.detectedProvider, "unknown");
  assert.equal(result.providerConfidence, "low");
  assert.equal(result.minimaxHits, 1);
  assert.equal(result.codexHits, 1);
});

test("detectProviderFromLabels — mixed labels resolve by majority", () => {
  const result = detectProviderFromLabels({
    filename: "Plan Usage Token Plan Monthly Plus Balance.png",
  });
  assert.equal(result.detectedProvider, "minimax");
});

test("normalizeMiniMaxRemaining — derives remaining from used when not supplied", () => {
  const out = normalizeMiniMaxRemaining({ shortWindowUsedPercent: 1, weeklyWindowUsedPercent: 81 });
  assert.equal(out.shortWindowUsedPercent, 1);
  assert.equal(out.shortWindowRemainingPercent, 99);
  assert.equal(out.weeklyWindowUsedPercent, 81);
  assert.equal(out.weeklyWindowRemainingPercent, 19);
});

test("normalizeMiniMaxRemaining — preserves explicit remaining values", () => {
  const out = normalizeMiniMaxRemaining({
    shortWindowUsedPercent: 50,
    shortWindowRemainingPercent: 42,
  });
  assert.equal(out.shortWindowUsedPercent, 50);
  assert.equal(out.shortWindowRemainingPercent, 42);
});

test("normalizeMiniMaxRemaining — clamps out-of-range inputs", () => {
  const out = normalizeMiniMaxRemaining({ shortWindowUsedPercent: 150 });
  assert.equal(out.shortWindowUsedPercent, 100);
  const out2 = normalizeMiniMaxRemaining({ weeklyWindowUsedPercent: -7 });
  assert.equal(out2.weeklyWindowUsedPercent, 0);
});

test("normalizeCodexRemaining — derives used from remaining", () => {
  const out = normalizeCodexRemaining({
    shortWindowRemainingPercent: 85,
    weeklyWindowRemainingPercent: 6,
  });
  assert.equal(out.shortWindowRemainingPercent, 85);
  assert.equal(out.shortWindowUsedPercent, 15);
  assert.equal(out.weeklyWindowRemainingPercent, 6);
  assert.equal(out.weeklyWindowUsedPercent, 94);
});

test("normalizeCodexRemaining — clamps out-of-range", () => {
  const out = normalizeCodexRemaining({ shortWindowRemainingPercent: 150 });
  assert.equal(out.shortWindowRemainingPercent, 100);
  assert.equal(out.shortWindowUsedPercent, 0);
});

test("parseSnapshotFromForm — MiniMax with used percents produces remaining", () => {
  const result = parseSnapshotFromForm({
    filename: "minimax-Plan-Usage.png",
    fields: {
      shortWindowUsedPercent: 1,
      weeklyWindowUsedPercent: 81,
      shortWindowLabel: "5h limit",
      weeklyWindowLabel: "Weekly limit",
      shortWindowResetLabel: "resets in 4 hr 44 min",
      weeklyWindowResetLabel: "resets in 3 days 8 hr",
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.providerId, "minimax");
  assert.equal(result.value.providerLabel, "MiniMax subscription");
  assert.equal(result.value.shortWindowUsedPercent, 1);
  assert.equal(result.value.shortWindowRemainingPercent, 99);
  assert.equal(result.value.weeklyWindowUsedPercent, 81);
  assert.equal(result.value.weeklyWindowRemainingPercent, 19);
  assert.equal(result.value.shortWindowResetLabel, "resets in 4 hr 44 min");
  assert.equal(result.value.weeklyWindowResetLabel, "resets in 3 days 8 hr");
  assert.equal(result.value.confidence, "observed");
});

test("parseSnapshotFromForm — Codex with remaining percents produces used", () => {
  const result = parseSnapshotFromForm({
    filename: "codex-Balance.png",
    fields: {
      shortWindowRemainingPercent: 85,
      weeklyWindowRemainingPercent: 6,
      shortWindowLabel: "5 hour usage limit",
      weeklyWindowLabel: "Weekly usage limit",
      shortWindowResetLabel: "Resets 8:05 PM",
      weeklyWindowResetLabel: "Resets Jul 7, 2026 10:48 AM",
      creditsRemaining: 0,
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.providerId, "codex");
  assert.equal(result.value.shortWindowRemainingPercent, 85);
  assert.equal(result.value.shortWindowUsedPercent, 15);
  assert.equal(result.value.weeklyWindowRemainingPercent, 6);
  assert.equal(result.value.weeklyWindowUsedPercent, 94);
  assert.equal(result.value.creditsRemaining, 0);
});

test("parseSnapshotFromForm — empty fields still parses (confidence = unknown)", () => {
  const result = parseSnapshotFromForm({
    filename: "unknown.png",
    fields: {},
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.shortWindowUsedPercent, null);
  assert.equal(result.value.shortWindowRemainingPercent, null);
  assert.equal(result.value.confidence, "unknown");
});

test("parseSnapshotFromForm — explicit providerId wins over heuristic", () => {
  const result = parseSnapshotFromForm({
    filename: "random.png",
    explicitProviderId: "codex",
    fields: { shortWindowRemainingPercent: 50 },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.providerId, "codex");
  assert.equal(result.value.shortWindowUsedPercent, 50);
});

test("buildExtractResult — always returns manual_placeholder and requiresUserConfirmation", () => {
  const result = buildExtractResult({
    filename: "minimax-Plan-Usage.png",
    fields: { shortWindowUsedPercent: 50 },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.extractionMode, "manual_placeholder");
  assert.equal(result.value.requiresUserConfirmation, true);
  // Heuristic-only confidence, never OCR-derived "high".
  assert.ok(["high", "low", "none"].includes(result.value.providerConfidence));
});
