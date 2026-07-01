import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { inferExecutionMode } from "./route.ts";

test("infers read-only for explicit no-write inspection", () => {
  assert.equal(inferExecutionMode("Do not modify files. Inspect only."), "read_only");
});

test("infers read-only for AGENTS.md inspection with no modify", () => {
  assert.equal(inferExecutionMode("Do we have AGENTS.md? Do not modify files."), "read_only");
});

test("infers workspace-write for patch with guardrails", () => {
  assert.equal(
    inferExecutionMode("Apply this patch. Keep the legacy feature available. Skip full E2E."),
    "workspace_write",
  );
});

test("infers workspace-write for copy update with no restart guardrail", () => {
  assert.equal(inferExecutionMode("Update copy. Skip production restart."), "workspace_write");
});

test("infers workspace-write for fix with no commit/push guardrail", () => {
  assert.equal(inferExecutionMode("Fix this bug. Skip commit and push."), "workspace_write");
});

test("infers workspace-write for implementation with provider billing guardrail", () => {
  assert.equal(
    inferExecutionMode("Implement the setting. Skip real provider billing."),
    "workspace_write",
  );
});

test("coding-harness recommend route labels recommender engine and execution model separately", () => {
  const source = readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");

  assert.match(source, /recommenderLane/);
  assert.match(source, /Router\/recommender engine/);
  assert.match(source, /fallbackRecommender/);
  assert.match(source, /executionModel/);
  assert.match(source, /selectionSource: "recommender_output"/);
});

test("coding-harness recommend route has no deterministic execution-model policy labels", () => {
  const source = readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");

  assert.doesNotMatch(source, /deterministic_coding_policy/);
  assert.doesNotMatch(source, /Deterministic coding policy/);
});

test("coding-harness recommend route's coding-recommender system prompt lists every required zod field name", () => {
  // Pin the prompt contract: the system prompt built by the route
  // must mention each required zod field by exact name so the model
  // doesn't drift into the alias shape (`modelId`, `provider`,
  // `reasoningLevel` at the top level instead of inside `alternatives`).
  const source = readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");

  assert.match(source, /"selectedHarness"/);
  assert.match(source, /"selectedModelId"/);
  assert.match(source, /"selectedReasoningLevel"/);
  assert.match(source, /"harnessExplanation"/);
  assert.match(source, /"modelExplanation"/);
  assert.match(source, /"alternatives"/);
});

test("coding-harness recommend route's coding-recommender system prompt forbids markdown fences and prose", () => {
  const source = readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");

  assert.match(source, /No markdown fences/);
  assert.match(source, /no prose/i);
  assert.match(source, /no comments/i);
  assert.match(source, /EXACTLY ONE JSON object/);
});

test("coding-harness recommend route's coding-recommender system prompt forbids alias field names", () => {
  // The brief says MiniMax-M3 has been observed returning alias
  // field names. The prompt must explicitly forbid them at the top
  // level — `modelId` / `reasoningLevel` belong only inside
  // `alternatives` items.
  const source = readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");

  assert.match(
    source,
    /"modelId"\s+is NOT a substitute for "selectedModelId"/,
  );
  assert.match(
    source,
    /"reasoningLevel"\s+is NOT a substitute for "selectedReasoningLevel"/,
  );
  assert.match(
    source,
    /"selectedProvider" \/ "provider" is NOT part of this schema/,
  );
});

test("coding-harness recommend route's coding-recommender system prompt includes a minimal valid JSON example", () => {
  // The prompt must anchor an exact valid-example shape so the
  // model doesn't invent extra fields or split harness / model
  // explanations.
  const source = readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");

  assert.match(source, /"selectedHarness": "minimax_cli"/);
  assert.match(source, /"selectedModelId": "MiniMax-M3"/);
  assert.match(source, /"selectedReasoningLevel": "provider_default"/);
  assert.match(source, /"harnessExplanation": "MiniMax CLI is the available harness/);
  assert.match(source, /"modelExplanation": "MiniMax-M3 is the authorized execution model/);
  assert.match(source, /"alternatives": \[\]/);
});
