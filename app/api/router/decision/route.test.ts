/**
 * Pure-function tests for the decision route helpers.
 *
 * Mirrors the style of `app/api/model/recommend/recommender-chain.test.ts`
 * and exercises the parts that own the failure-classification contract:
 *
 *   - `parseJsonObjectFromText` must handle fenced, prefixed,
 *     and bare JSON, and throw the canonical
 *     `decision_model_returned_non_json` for prose-only output.
 *   - `classifyDecisionError` must map the upstream error
 *     strings (Codex CLI, AI SDK, our own helpers, and the
 *     runtime) to the closed `DecisionErrorType` discriminator
 *     without ever leaking secrets.
 *   - `buildErrorDetails` must reflect the four success / failure
 *     shapes the UI cares about:
 *       1. Primary succeeded, fallback not configured.
 *       2. Primary succeeded, fallback configured but not attempted.
 *       3. Primary failed (usage_limit), fallback succeeded.
 *       4. Both failed (no rung succeeded, final = manual_after_model_error).
 *
 * These tests do NOT touch the network, the DB, or `process.env`,
 * so they run under the same `npm test` glob as the other suite
 * files. They are the safety net for the brief's "do not silently
 * substitute, do not hide failures" requirement.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildErrorDetails,
  classifyDecisionError,
  parseJsonObjectFromText,
  type RungAttempt,
} from "./route";
import type { ConfiguredRecommenderRung } from "@/lib/router/recommender-config";

function makeRung(
  source: "configured" | "configured_fallback",
  modelId: string,
): ConfiguredRecommenderRung {
  const providerId: ConfiguredRecommenderRung["providerId"] = modelId.startsWith("codex:")
    ? "codex"
    : modelId.startsWith("MiniMax-") || modelId.startsWith("minimax:")
      ? "minimax"
      : "openai";
  return { source, providerId, modelId, reasoningLevel: undefined };
}

function makeAttempt(
  source: "configured" | "configured_fallback",
  modelId: string,
  overrides: Partial<RungAttempt> = {},
): RungAttempt {
  return {
    source,
    modelId,
    providerId: "unknown",
    attempted: true,
    succeeded: false,
    errorType: "unknown",
    errorMessageSafe: null,
    ...overrides,
  };
}

test("parseJsonObjectFromText: bare JSON parses", () => {
  const out = parseJsonObjectFromText('{"decision":"normal_chat","reason":"x","ambiguity":"low","signals":["a"]}');
  assert.equal((out as { decision: string }).decision, "normal_chat");
});

test("parseJsonObjectFromText: fenced markdown JSON parses", () => {
  const out = parseJsonObjectFromText(
    '```json\n{"decision":"coding_task","reason":"x","ambiguity":"low","signals":[]}\n```',
  );
  assert.equal((out as { decision: string }).decision, "coding_task");
});

test("parseJsonObjectFromText: prose wrapping JSON parses", () => {
  const out = parseJsonObjectFromText(
    'Sure, here you go:\n{"decision":"normal_chat","reason":"x","ambiguity":"low","signals":[]}\nThanks!',
  );
  assert.equal((out as { decision: string }).decision, "normal_chat");
});

test("parseJsonObjectFromText: empty string throws canonical error", () => {
  assert.throws(
    () => parseJsonObjectFromText(""),
    (err) => err instanceof Error && err.message === "decision_model_returned_non_json",
  );
});

test("parseJsonObjectFromText: prose-only response throws canonical error", () => {
  assert.throws(
    () => parseJsonObjectFromText("I cannot decide for you. Please clarify."),
    (err) => err instanceof Error && err.message === "decision_model_returned_non_json",
  );
});

test("parseJsonObjectFromText: malformed JSON inside braces throws canonical error", () => {
  assert.throws(
    () => parseJsonObjectFromText('Here you go: {decision: "normal_chat"}'),
    (err) => err instanceof Error && err.message === "decision_model_returned_non_json",
  );
});

test("classifyDecisionError: Codex usage_limit maps to usage_limit", () => {
  const c = classifyDecisionError(new Error("Codex usage limit reached."));
  assert.equal(c.type, "usage_limit");
  assert.equal(c.messageSafe, "Codex usage limit reached.");
});

test("classifyDecisionError: AI SDK structured-output parse failure maps to schema_parse", () => {
  const c = classifyDecisionError(new Error("No object generated: could not parse the response."));
  assert.equal(c.type, "schema_parse");
});

test("classifyDecisionError: AI SDK structured-output schema failure maps to schema_validation", () => {
  const c = classifyDecisionError(
    new Error("No object generated: response did not match schema."),
  );
  assert.equal(c.type, "schema_validation");
});

test("classifyDecisionError: our own parse-failed message maps to schema_parse", () => {
  const c = classifyDecisionError(new Error("decision_parse_failed: oops"));
  assert.equal(c.type, "schema_parse");
});

test("classifyDecisionError: our own schema-validation message maps to schema_validation", () => {
  const c = classifyDecisionError(new Error("decision_schema_validation_failed: reason: too long"));
  assert.equal(c.type, "schema_validation");
});

test("classifyDecisionError: empty output maps to empty_output", () => {
  const c = classifyDecisionError(new Error("decision_empty_output"));
  assert.equal(c.type, "empty_output");
});

test("classifyDecisionError: missing CLI maps to provider_configuration_error", () => {
  const c = classifyDecisionError(new Error("codex_cli_not_installed"));
  assert.equal(c.type, "provider_configuration_error");
});

test("classifyDecisionError: missing API key never leaks the secret", () => {
  const c = classifyDecisionError(new Error("ProviderConfigurationError: MINIMAX_API_KEY missing"));
  assert.equal(c.type, "provider_configuration_error");
  assert.doesNotMatch(c.messageSafe, /MINIMAX_API_KEY/);
});

test("classifyDecisionError: rate limit maps to network", () => {
  const c = classifyDecisionError(new Error("429 Too Many Requests"));
  assert.equal(c.type, "network");
});

test("classifyDecisionError: unknown errors fall through to unknown", () => {
  const c = classifyDecisionError(new Error("something weird happened"));
  assert.equal(c.type, "unknown");
});

test("buildErrorDetails: primary succeeded, no fallback configured", () => {
  const chain = [makeRung("configured", "codex:gpt-5.4-mini")];
  const attempts = [
    makeAttempt("configured", "codex:gpt-5.4-mini", {
      providerId: "codex",
      succeeded: true,
      errorType: "unknown",
      errorMessageSafe: null,
    }),
    // synthetic not-attempted fallback record (added when no
    // fallback was configured AND the chain walked all rungs)
    makeAttempt("configured_fallback", "<none-configured>", {
      providerId: "unknown",
      attempted: false,
      succeeded: false,
      errorType: "not_attempted",
      errorMessageSafe: "No fallback recommender is configured.",
    }),
  ];
  const out = buildErrorDetails({ chain, attempts, finalSource: "model" });
  assert.equal(out.primary_recommender_model_id, "codex:gpt-5.4-mini");
  assert.equal(out.primary_provider_path, "codex");
  assert.equal(out.primary_error_type, null);
  assert.equal(out.primary_error_message_safe, null);
  assert.equal(out.fallback_recommender_model_id, null);
  assert.equal(out.fallback_attempted, false);
  assert.equal(out.fallback_error_type, "not_attempted");
  assert.equal(out.fallback_error_message_safe, "No fallback recommender is configured.");
  assert.equal(out.final_decision_source, "model");
});

test("buildErrorDetails: primary failed (usage_limit), fallback succeeded", () => {
  const chain = [
    makeRung("configured", "codex:gpt-5.5"),
    makeRung("configured_fallback", "MiniMax-M3"),
  ];
  const attempts = [
    makeAttempt("configured", "codex:gpt-5.5", {
      providerId: "codex",
      succeeded: false,
      errorType: "usage_limit",
      errorMessageSafe: "Codex usage limit reached.",
    }),
    makeAttempt("configured_fallback", "MiniMax-M3", {
      providerId: "minimax",
      succeeded: true,
      errorType: "unknown",
      errorMessageSafe: null,
    }),
  ];
  const out = buildErrorDetails({ chain, attempts, finalSource: "model" });
  assert.equal(out.primary_error_type, "usage_limit");
  assert.equal(out.primary_error_message_safe, "Codex usage limit reached.");
  assert.equal(out.fallback_recommender_model_id, "MiniMax-M3");
  assert.equal(out.fallback_attempted, true);
  assert.equal(out.fallback_error_type, null);
  assert.equal(out.fallback_error_message_safe, null);
  assert.equal(out.final_decision_source, "model");
});

test("buildErrorDetails: both failed \u2014 final = manual_after_model_error", () => {
  const chain = [
    makeRung("configured", "codex:gpt-5.5"),
    makeRung("configured_fallback", "MiniMax-M3"),
  ];
  const attempts = [
    makeAttempt("configured", "codex:gpt-5.5", {
      providerId: "codex",
      succeeded: false,
      errorType: "usage_limit",
      errorMessageSafe: "Codex usage limit reached.",
    }),
    makeAttempt("configured_fallback", "MiniMax-M3", {
      providerId: "minimax",
      succeeded: false,
      errorType: "schema_validation",
      errorMessageSafe: "Model returned JSON that did not match the schema.",
    }),
  ];
  const out = buildErrorDetails({ chain, attempts, finalSource: "manual_after_model_error" });
  assert.equal(out.primary_error_type, "usage_limit");
  assert.equal(out.fallback_attempted, true);
  assert.equal(out.fallback_error_type, "schema_validation");
  assert.equal(
    out.fallback_error_message_safe,
    "Model returned JSON that did not match the schema.",
  );
  assert.equal(out.final_decision_source, "manual_after_model_error");
});

test("buildErrorDetails: primary succeeded, fallback configured but not attempted", () => {
  const chain = [
    makeRung("configured", "MiniMax-M3"),
    makeRung("configured_fallback", "codex:gpt-5.4-mini"),
  ];
  const attempts = [
    makeAttempt("configured", "MiniMax-M3", {
      providerId: "minimax",
      succeeded: true,
      errorType: "unknown",
      errorMessageSafe: null,
    }),
  ];
  const out = buildErrorDetails({ chain, attempts, finalSource: "model" });
  assert.equal(out.primary_error_type, null);
  assert.equal(out.primary_error_message_safe, null);
  assert.equal(out.fallback_recommender_model_id, "codex:gpt-5.4-mini");
  assert.equal(out.fallback_attempted, false);
  assert.equal(out.fallback_error_type, "not_attempted");
  assert.equal(out.fallback_error_message_safe, "Primary succeeded; fallback was not attempted.");
});