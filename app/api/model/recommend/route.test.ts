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

test("model/recommend route returns a top-level `panel` field on a successful recommendation", () => {
  // The new RoutingDecisionPanel payload is the canonical wire
  // shape. The route must include it on the success response so
  // the client can render the new compact editable panel.
  assert.match(
    SOURCE,
    /return\s+Response\.json\(\{[\s\S]{0,400}panel,/,
    "success response must include a `panel` field",
  );
});

test("model/recommend route returns a top-level `panel` field on the loud-failure path", () => {
  // The loud-failure path uses buildPanelForLoudFailure to
  // surface the user's current selection without auto-
  // substituting a hidden third rung.
  assert.match(
    SOURCE,
    /loudFailurePanel\s*=\s*buildPanelForLoudFailure/,
    "catch block must build a loud-failure panel payload",
  );
  assert.match(
    SOURCE,
    /panel:\s*loudFailurePanel/,
    "catch response must include the loud-failure panel",
  );
});

test("model/recommend route does NOT default to a third Codex / MiniMax rung on loud failure", () => {
  // The brief: "no silent API-billing fallback" and "no silent
  // fallback to a different model". The loud-failure panel must
  // surface the user's current selection, not a hidden default.
  // Source-grep pins the absence of a hardcoded Codex / MiniMax
  // rung in the loud-failure panel path.
  const forbidden = [
    /loudFailurePanel[\s\S]{0,400}"codex:gpt-5\.4-mini"/,
    /loudFailurePanel[\s\S]{0,400}"MiniMax-M3"/,
    /loudFailurePanel[\s\S]{0,400}"gpt-5\.4-mini"/,
  ];
  for (const pattern of forbidden) {
    assert.equal(
      pattern.test(SOURCE),
      false,
      `loud-failure panel must not default to a hidden rung: ${pattern}`,
    );
  }
});

test("model/recommend route imports the new panel + classifier helpers", () => {
  // The success path needs the panel builder, the classifier,
  // and the new types. Source-grep pins the imports so a future
  // refactor that removes them regresses this test.
  assert.match(SOURCE, /import\s*\{[^}]*buildPanelFromRecommenderValue/);
  assert.match(SOURCE, /import\s*\{[^}]*buildPanelForLoudFailure/);
  assert.match(SOURCE, /import\s*\{[^}]*classifyContextDecision/);
  assert.match(SOURCE, /import\s*\{[^}]*RoutingDecisionPanel/);
});

test("model/recommend route excludes ROUTER model ids from execution panel options", () => {
  // The brief: "ROUTER models are recommender engines only,
  // never execution models." The success path must consult an
  // executionBlocklist built from
  // settings.normalChatRecommenderModelId +
  // settings.normalChatRecommenderFallbackModelId so the panel
  // builder can refuse a ROUTER id as an execution pick.
  assert.match(
    SOURCE,
    /executionBlocklist:\s*\[[\s\S]*?normalChatRecommenderModelId[\s\S]*?normalChatRecommenderFallbackModelId/,
    "executionBlocklist must include both configured recommender ids",
  );
});
