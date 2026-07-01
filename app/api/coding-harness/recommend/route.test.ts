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
