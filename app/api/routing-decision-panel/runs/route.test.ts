import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SOURCE = readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");

test("routing-decision-panel/runs POST persists panel + selection + diff + comment", () => {
  // The POST handler must call createFullRoutingDecisionRun
  // with all four fields. Source-grep pins the call.
  assert.match(SOURCE, /createFullRoutingDecisionRun\(/);
  assert.match(SOURCE, /panel:\s*data\.panel/);
  assert.match(SOURCE, /selection:\s*data\.selection/);
  assert.match(SOURCE, /changedFields:\s*data\.changedFields/);
  assert.match(SOURCE, /comment:\s*data\.comment/);
});

test("routing-decision-panel/runs POST enforces a 1000-char cap on the comment", () => {
  // The brief caps the comment at 1000 chars. The route's
  // zod schema and the repo helper both enforce this — the
  // schema rejects overlong comments so the client cannot smuggle
  // an unbounded payload.
  assert.match(SOURCE, /comment:\s*z\.string\(\)\.max\(1000\)/);
});

test("routing-decision-panel/runs PATCH refuses to overwrite the panel", () => {
  // The PATCH handler must accept only selection /
  // changedFields / comment — NOT the panel. Source-grep pins
  // the omission so a regression that lets the client overwrite
  // the original recommendation is caught.
  assert.doesNotMatch(SOURCE, /updateSchema[\s\S]{0,400}panel:\s*panelSchema/);
});

test("routing-decision-panel/runs POST uses the new enum values verbatim", () => {
  // The brief: "Allowed enum values: contextDecision:
  // chat_only | harness_needed; harness: normal_chat |
  // repo_file_harness". The zod schema must use the new enum
  // names — NOT the legacy `normal_chat | coding_task`.
  assert.match(SOURCE, /z\.enum\(\[\s*"chat_only"\s*,\s*"harness_needed"\s*\]\)/);
  assert.match(SOURCE, /z\.enum\(\[\s*"normal_chat"\s*,\s*"repo_file_harness"\s*\]\)/);
});

test("routing-decision-panel/runs POST validates changedFields as the closed enum", () => {
  // changedFields is the diff payload — must be a closed
  // [context, model, reasoning, harness] array so dashboards
  // can compute correction rates per field.
  assert.match(
    SOURCE,
    /z\.array\(\s*z\.enum\(\[\s*"context"\s*,\s*"model"\s*,\s*"reasoning"\s*,\s*"harness"\s*\]\)/,
  );
});

test("routing-decision-panel/runs POST accepts a `null` threadId", () => {
  // Local (non-persisted) threads carry a `local-*` id and
  // the route must accept threadId: null. The zod schema pins
  // this so a future tightening does not break local-thread
  // sends.
  assert.match(SOURCE, /threadId:\s*z\.string\(\)\.nullable\(\)\.optional\(\)/);
});

test("routing-decision-panel/runs PATCH requires a runId UUID", () => {
  // The PATCH handler targets an existing row by id; the schema
  // must require a UUID so a missing runId fails fast.
  assert.match(SOURCE, /runId:\s*z\.string\(\)\.uuid\(\)/);
});