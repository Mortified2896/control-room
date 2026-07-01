import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Source-level guards for the normal-chat recommender route.
 *
 * These tests pin the GPT-5.4 Mini cleanup so a future refactor
 * that re-introduces `codex:gpt-5.4-mini` / `gpt-5.4-mini` /
 * `"GPT-5.4 Mini"` as a hardcoded fallback in the route regresses
 * one of these tests. This file is intentionally small — it only
 * covers the loud-failure / proposal / fallback-shape contracts
 * that could silently reintroduce a third rung.
 */

const SOURCE = readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");

test("model/recommend route does not hardcode codex:gpt-5.4-mini as a catch-block fallback default", () => {
  // The previous hardcoded candidate list appended Codex and
  // MiniMax as automatic subscription proposals regardless of
  // configuration. We removed that. The route should no longer
  // carry a `modelId: "codex:gpt-5.4-mini"` literal anywhere
  // except in code-comment text or docstrings explaining the
  // removal.
  const candidateMatches = SOURCE.match(/modelId:\s*"codex:gpt-5\.4-mini"/g) ?? [];
  assert.equal(
    candidateMatches.length,
    0,
    `expected zero literal codex:gpt-5.4-mini candidate entries, found ${candidateMatches.length}`,
  );
});

test("model/recommend route does not default requested.modelId to gpt-5.4-mini in the catch block", () => {
  // The previous default `requested.modelId ?? "gpt-5.4-mini"` was a
  // hidden third rung. We now use `requested.modelId ?? ""`.
  const pattern = /requested:\s*\{[\s\S]{0,200}modelId:\s*input\.currentModelId\s*\?\?\s*"gpt-5\.4-mini"/;
  assert.equal(
    pattern.test(SOURCE),
    false,
    "catch block must not default requested.modelId to gpt-5.4-mini",
  );
});

test("model/recommend route does not default recommendedModelId to gpt-5.4-mini in fallbackResponse", () => {
  // Same rule for the loud-failure recommendedModelId default.
  const pattern = /recommendedModelId:\s*input\.currentModelId\s*\?\?\s*"gpt-5\.4-mini"/;
  assert.equal(
    pattern.test(SOURCE),
    false,
    "fallbackResponse must not default recommendedModelId to gpt-5.4-mini",
  );
});

test("model/recommend route does not default to codex:gpt-5.4-mini when no recommender rung was tried", () => {
  // The active-recommender last-resort: previously defaulted to
  // `codex:gpt-5.4-mini`. Now we use the configured primary.
  const pattern = /lastAttempt\?\.modelId\s*\?\?\s*[^,\n]*"\s*\?\?\s*"codex:gpt-5\.4-mini"/;
  assert.equal(
    pattern.test(SOURCE),
    false,
    "active-recommender last-resort must not default to codex:gpt-5.4-mini",
  );
});

test("model/recommend route derives proposedSubscriptionFallbacks candidates from live availableModels", () => {
  // The catch-block proposal candidates are now built from
  // `availableModels` (the live registry) so a third
  // Codex/MiniMax/OpenAI rung is never appended. The block must
  // reference `availableModels` directly when building candidates.
  assert.match(
    SOURCE,
    /proposalCandidates\s*=\s*\([\s\S]*?availableModels/,
    "proposalCandidates should be derived from availableModels",
  );
});
