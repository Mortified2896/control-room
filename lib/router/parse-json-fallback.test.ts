import test from "node:test";
import assert from "node:assert/strict";

import {
  tryParseJsonObjectFromText,
  tryRecoverJsonObjectFromAiSdkError,
  extractRawTextFromNoObjectError,
} from "./parse-json-fallback";

test("raw strict JSON parses with strategy=raw", () => {
  const text = '{"selectedHarness":"codex_cli","selectedModelId":"gpt-5.5"}';
  const res = tryParseJsonObjectFromText(text);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.strategy, "raw");
    assert.deepEqual(res.value, { selectedHarness: "codex_cli", selectedModelId: "gpt-5.5" });
  }
});

test("fenced ```json block parses with strategy=fenced", () => {
  const text = [
    "<think>",
    "MiniMax reasoning here, no JSON yet.",
    "</think>",
    "",
    "```json",
    "{",
    '  "selectedHarness": "minimax_cli",',
    '  "selectedModelId": "MiniMax-M3",',
    '  "selectedReasoningLevel": "provider_default"',
    "}",
    "```",
  ].join("\n");
  const res = tryParseJsonObjectFromText(text);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.strategy, "fenced");
    assert.deepEqual(res.value, {
      selectedHarness: "minimax_cli",
      selectedModelId: "MiniMax-M3",
      selectedReasoningLevel: "provider_default",
    });
  }
});

test("fenced ``` block without 'json' tag still parses", () => {
  const text = "```\n{\"a\":1}\n```";
  const res = tryParseJsonObjectFromText(text);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.strategy, "fenced");
    assert.deepEqual(res.value, { a: 1 });
  }
});

test("prose-wrapped JSON parses via brace-slice as a last resort", () => {
  const text =
    'Sure! Here is the JSON payload you asked for: {"selectedHarness":"codex_cli","selectedModelId":"gpt-5.5"} -- hope that helps.';
  const res = tryParseJsonObjectFromText(text);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.strategy, "brace-slice");
    assert.deepEqual(res.value, { selectedHarness: "codex_cli", selectedModelId: "gpt-5.5" });
  }
});

test("empty text returns a structured failure (not a throw)", () => {
  const res = tryParseJsonObjectFromText("");
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, "recommender_returned_empty_text");
  }
  const res2 = tryParseJsonObjectFromText(null);
  assert.equal(res2.ok, false);
  if (!res2.ok) {
    assert.equal(res2.reason, "recommender_returned_empty_text");
  }
});

test("JSON string scalar (not an object) is rejected", () => {
  const res = tryParseJsonObjectFromText('"hello"');
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, "recommender_returned_non_json_object");
  }
});

test("JSON array is rejected (not an object)", () => {
  const res = tryParseJsonObjectFromText("[1,2,3]");
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, "recommender_returned_non_json_object");
  }
});

test("malformed fenced JSON returns a structured failure", () => {
  const text = "```json\n{not valid}\n```";
  const res = tryParseJsonObjectFromText(text);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, "recommender_returned_non_json_object");
    assert.match(res.preview, /not valid/);
  }
});

test("plain prose without any JSON object returns a structured failure", () => {
  const res = tryParseJsonObjectFromText("Hello! No JSON here, just friendly prose.");
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, "recommender_returned_non_json_object");
  }
});

test("preview is capped at 200 chars", () => {
  const huge = "x".repeat(5000);
  const res = tryParseJsonObjectFromText(huge);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.preview.length <= 200);
  }
});

test("MiniMax-style response with think block + fenced JSON parses", () => {
  // Captured shape from a live MiniMax-M3 response.
  const text = [
    "<think>",
    "The user wants me to recommend a coding harness and model. Let me analyze the inputs:",
    "1. **Task**: Investigate why the live recommendation is blocked",
    "2. **Recommender Lane**: default (deterministic)",
    "3. **Token count**: 727 tokens, well below the 30,000 large context threshold",
    "Since Codex CLI is unavailable due to exhausted token limit, I must select MiniMax CLI.",
    "Let me construct the response with selectedHarness: minimax_cli, selectedModelId: MiniMax-M3.",
    "</think>",
    "",
    "```json",
    "{",
    '  "selectedHarness": "minimax_cli",',
    '  "selectedModelId": "MiniMax-M3",',
    '  "selectedReasoningLevel": "provider_default",',
    '  "harnessExplanation": "Codex CLI is the higher-tier authorized harness but its live status reports unavailable.",',
    '  "modelExplanation": "MiniMax-M3 is the authorized execution model under the MiniMax subscription path.",',
    '  "alternatives": [',
    "    {",
    '      "harness": "codex_cli",',
    '      "modelId": "gpt-5.5",',
    '      "reasoningLevel": "low",',
    '      "reason": "Re-evaluate once Codex token quota is restored."',
    "    }",
    "  ]",
    "}",
    "```",
  ].join("\n");
  const res = tryParseJsonObjectFromText(text);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.strategy, "fenced");
    const v = res.value as Record<string, unknown>;
    assert.equal(v.selectedHarness, "minimax_cli");
    assert.equal(v.selectedModelId, "MiniMax-M3");
    assert.equal(v.selectedReasoningLevel, "provider_default");
    assert.ok(Array.isArray(v.alternatives));
    assert.equal((v.alternatives as Array<unknown>).length, 1);
  }
});

test("NoObjectGeneratedError carries recoverable raw text", () => {
  const fakeErr = {
    name: "AI_NoObjectGeneratedError",
    message: "No object generated: could not parse the response.",
    text: '```json\n{"a":1}\n```',
  };
  const text = extractRawTextFromNoObjectError(fakeErr);
  assert.equal(typeof text, "string");
  const recovered = tryRecoverJsonObjectFromAiSdkError(fakeErr);
  assert.ok(recovered);
  assert.equal(recovered?.ok, true);
  if (recovered?.ok) {
    assert.equal(recovered.strategy, "fenced");
    assert.deepEqual(recovered.value, { a: 1 });
  }
});

test("non-NoObjectGeneratedError returns null from recovery helper", () => {
  const res = tryRecoverJsonObjectFromAiSdkError(new Error("boom"));
  assert.equal(res, null);
  const res2 = tryRecoverJsonObjectFromAiSdkError(null);
  assert.equal(res2, null);
  const res3 = tryRecoverJsonObjectFromAiSdkError({ name: "OtherError", text: '{"a":1}' });
  assert.equal(res3, null);
});

test("NoObjectGeneratedError without text returns failure", () => {
  const fakeErr = {
    name: "AI_NoObjectGeneratedError",
    message: "No object generated: could not parse the response.",
    // no text field
  };
  const recovered = tryRecoverJsonObjectFromAiSdkError(fakeErr);
  assert.equal(recovered, null);
});