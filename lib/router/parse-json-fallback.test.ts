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

test("extracted normal-chat JSON with correct field names passes zod re-validation", () => {
  // MiniMax-M3, given the schema-conformant prompt, returns the
  // EXACT zod-required field names. After fenced-JSON extraction,
  // the same zod schema that powers the AI SDK `Output.object({
  // schema })` call MUST accept the value. We do not guess or
  // coerce fields; we re-validate strictly.
  const { z } = require("zod/v4") as typeof import("zod/v4");
  const outputSchema = z.object({
    recommendedModelId: z.string().min(1),
    recommendedProvider: z.string().min(1),
    recommendedReasoningLevel: z.string().min(1).nullable(),
    reasoning: z.string().min(1).max(200),
    alternatives: z.array(
      z.object({
        modelId: z.string().min(1),
        provider: z.string().min(1),
        recommendedReasoningLevel: z.string().min(1).nullable(),
        reason: z.string().min(1).max(160),
      }),
    ),
  });
  const text =
    "```json\n" +
    JSON.stringify({
      recommendedModelId: "MiniMax-M3",
      recommendedProvider: "minimax",
      recommendedReasoningLevel: null,
      reasoning:
        "Cheap MiniMax subscription is enough for this conversational question.",
      alternatives: [],
    }) +
    "\n```";
  const extracted = tryParseJsonObjectFromText(text);
  assert.equal(extracted.ok, true);
  if (!extracted.ok) return;
  assert.equal(extracted.strategy, "fenced");
  const validated = outputSchema.safeParse(extracted.value);
  assert.equal(validated.success, true);
  if (validated.success) {
    assert.equal(validated.data.recommendedModelId, "MiniMax-M3");
    assert.equal(validated.data.recommendedProvider, "minimax");
    assert.equal(validated.data.recommendedReasoningLevel, null);
    assert.match(validated.data.reasoning, /MiniMax/);
  }
});

test("extracted MiniMax normal-chat response with WRONG field names fails zod re-validation", () => {
  // The pre-fix bad shape was
  //   {"modelId":"MiniMax-M3","provider":"minimax","reasoningLevel":null}
  // i.e. alias field names. The extractor pulls the JSON out of the
  // fence, but strict zod re-validation rejects it because none of
  // the required field names appear. The route never accepts a
  // non-conformant payload.
  const { z } = require("zod/v4") as typeof import("zod/v4");
  const outputSchema = z.object({
    recommendedModelId: z.string().min(1),
    recommendedProvider: z.string().min(1),
    recommendedReasoningLevel: z.string().min(1).nullable(),
    reasoning: z.string().min(1).max(200),
    alternatives: z.array(z.any()),
  });
  const text =
    "```json\n" +
    JSON.stringify({
      modelId: "MiniMax-M3",
      provider: "minimax",
      reasoningLevel: null,
    }) +
    "\n```";
  const extracted = tryParseJsonObjectFromText(text);
  assert.equal(extracted.ok, true);
  if (!extracted.ok) return;
  assert.equal(extracted.strategy, "fenced");
  const validated = outputSchema.safeParse(extracted.value);
  assert.equal(validated.success, false, "alias field names must be rejected");
  if (!validated.success) {
    const missing = validated.error.issues.map((i) => i.path.join("."));
    assert.ok(
      missing.some((p) => p.includes("recommendedModelId")),
      "expected recommendedModelId validation error",
    );
    assert.ok(
      missing.some((p) => p.includes("recommendedProvider")),
      "expected recommendedProvider validation error",
    );
    assert.ok(
      missing.some((p) => p.includes("reasoning")),
      "expected reasoning validation error",
    );
  }
});

test("extracted normal-chat JSON missing required reasoning field fails zod re-validation", () => {
  // The brief mandates `normal-chat fallback output requires
  // explanation`. Even with the right field NAMES at the top level,
  // omitting `reasoning` must fail. The zod schema enforces that:
  // `reasoning: z.string().min(1).max(200)`.
  const { z } = require("zod/v4") as typeof import("zod/v4");
  const outputSchema = z.object({
    recommendedModelId: z.string().min(1),
    recommendedProvider: z.string().min(1),
    recommendedReasoningLevel: z.string().min(1).nullable(),
    reasoning: z.string().min(1).max(200),
    alternatives: z.array(z.any()),
  });
  const text =
    "```json\n" +
    JSON.stringify({
      recommendedModelId: "MiniMax-M3",
      recommendedProvider: "minimax",
      recommendedReasoningLevel: null,
    }) +
    "\n```";
  const extracted = tryParseJsonObjectFromText(text);
  assert.equal(extracted.ok, true);
  if (!extracted.ok) return;
  const validated = outputSchema.safeParse(extracted.value);
  assert.equal(validated.success, false);
  if (!validated.success) {
    const missing = validated.error.issues.map((i) => i.path.join("."));
    assert.ok(
      missing.some((p) => p === "reasoning"),
      "expected reasoning validation error",
    );
  }
});

test("extracted coding-harness JSON missing harnessExplanation fails zod re-validation", () => {
  // Coding-harness schema requires `harnessExplanation` AND
  // `modelExplanation`. Empty / missing must fail loud.
  const { z } = require("zod/v4") as typeof import("zod/v4");
  const outputSchema = z.object({
    selectedHarness: z.enum(["codex_cli", "minimax_cli"]),
    selectedModelId: z.string().min(1),
    selectedReasoningLevel: z.string().min(1),
    harnessExplanation: z.string().min(1).max(500),
    modelExplanation: z.string().min(1).max(500),
    alternatives: z.array(z.any()).default([]),
  });
  const text =
    "```json\n" +
    JSON.stringify({
      selectedHarness: "minimax_cli",
      selectedModelId: "MiniMax-M3",
      selectedReasoningLevel: "provider_default",
      harnessExplanation: "",
      modelExplanation: "explanation",
    }) +
    "\n```";
  const extracted = tryParseJsonObjectFromText(text);
  assert.equal(extracted.ok, true);
  if (!extracted.ok) return;
  const validated = outputSchema.safeParse(extracted.value);
  assert.equal(validated.success, false);
  if (!validated.success) {
    const issuePaths = validated.error.issues.map((i) => i.path.join("."));
    assert.ok(
      issuePaths.some((p) => p === "harnessExplanation"),
      "expected harnessExplanation validation error",
    );
  }
});

test("extracted coding-harness JSON missing modelExplanation fails zod re-validation", () => {
  const { z } = require("zod/v4") as typeof import("zod/v4");
  const outputSchema = z.object({
    selectedHarness: z.enum(["codex_cli", "minimax_cli"]),
    selectedModelId: z.string().min(1),
    selectedReasoningLevel: z.string().min(1),
    harnessExplanation: z.string().min(1).max(500),
    modelExplanation: z.string().min(1).max(500),
    alternatives: z.array(z.any()).default([]),
  });
  const text =
    "```json\n" +
    JSON.stringify({
      selectedHarness: "minimax_cli",
      selectedModelId: "MiniMax-M3",
      selectedReasoningLevel: "provider_default",
      harnessExplanation: "harness explanation",
      modelExplanation: "",
    }) +
    "\n```";
  const extracted = tryParseJsonObjectFromText(text);
  assert.equal(extracted.ok, true);
  if (!extracted.ok) return;
  const validated = outputSchema.safeParse(extracted.value);
  assert.equal(validated.success, false);
  if (!validated.success) {
    const issuePaths = validated.error.issues.map((i) => i.path.join("."));
    assert.ok(
      issuePaths.some((p) => p === "modelExplanation"),
      "expected modelExplanation validation error",
    );
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