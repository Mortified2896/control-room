import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNormalChatRecommenderPrompt,
  buildNormalChatRecommenderUserPrompt,
  NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT,
} from "./normal-chat-prompts.ts";

const sampleInput = {
  mode: "normal_chat" as const,
  message: "Help me debug a Postgres query that's returning wrong rows.",
  current: {
    modelId: "gpt-5.4-mini",
    provider: "openai",
    reasoningLevel: "low" as const,
  },
  availableModels: [
    {
      provider: "openai",
      modelId: "gpt-5.4-mini",
      displayLabel: "GPT-5.4 Mini",
      supportsReasoningControls: true,
      allowedReasoningLevels: ["low", "medium", "high"] as const,
      enabled: true,
      accessPath: "openai_api" as const,
      tier: "cheap" as const,
    },
    {
      provider: "openai",
      modelId: "gpt-5.5",
      displayLabel: "GPT-5.5",
      supportsReasoningControls: true,
      allowedReasoningLevels: ["low", "medium", "high"] as const,
      enabled: true,
      accessPath: "openai_api" as const,
      tier: "expensive" as const,
    },
  ],
};

test("NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT is a non-empty plain-English string", () => {
  assert.ok(typeof NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT === "string");
  assert.ok(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT.length > 50);
  // The prompt must mention that the model picks a model + reasoning
  // level, and constrain the recommendation to the provided list.
  assert.match(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /recommend/i);
  assert.match(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /model/i);
  assert.match(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /reasoning/i);
});

test("NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT requires the exact zod field names", () => {
  // The schema requires these exact top-level field names. The system
  // prompt must list them literally so the prompt does not drift
  // from the zod schema and so the AI SDK's Output.object call
  // validates the response. Aliases (modelId / provider /
  // reasoningLevel) are forbidden.
  assert.match(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /"recommendedRoute"/);
  assert.match(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /"routeReason"/);
  assert.match(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /"recommendedModelId"/);
  assert.match(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /"recommendedProvider"/);
  assert.match(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /"recommendedReasoningLevel"/);
  assert.match(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /"reasoning"/);
  assert.match(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /"alternatives"/);
});

test("NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT forbids alias field names", () => {
  // The MiniMax-M3 recommender engine has been observed returning
  // the alias shape `{"modelId":"X","provider":"Y","reasoningLevel":null}`.
  // That shape is wrong for the schema. The prompt must explicitly
  // forbid it.
  assert.match(
    NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT,
    /"modelId"\s+is NOT a substitute for "recommendedModelId"/,
  );
  assert.match(
    NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT,
    /"provider"\s+is NOT a substitute for "recommendedProvider"/,
  );
  assert.match(
    NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT,
    /"reasoningLevel"\s+is NOT a substitute for "recommendedReasoningLevel"/,
  );
});

test("NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT forbids markdown fences and prose", () => {
  assert.match(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /no markdown fences/i);
  assert.match(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /no prose/i);
  assert.match(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /exactly one json object/i);
});

test("NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT includes a minimal valid JSON example", () => {
  // The example anchors the exact field names and shape so the model
  // doesn't drift into any wrapper / fence / alias form.
  assert.match(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /"recommendedRoute": "normal_chat"/);
  assert.match(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /"routeReason":/);
  assert.match(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /"recommendedModelId": "MiniMax-M3"/);
  assert.match(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /"recommendedProvider": "minimax"/);
  assert.match(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /"recommendedReasoningLevel": null/);
  assert.match(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /"reasoning":/);
  assert.match(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /"alternatives": \[\]/);
});

test("buildNormalChatRecommenderUserPrompt returns valid JSON containing the input fields", () => {
  const userPrompt = buildNormalChatRecommenderUserPrompt(sampleInput);
  // The user prompt must be JSON-serializable — the API route sends it
  // as a single user message and the model must parse it.
  const parsed = JSON.parse(userPrompt);
  assert.equal(parsed.mode, "normal_chat");
  assert.equal(parsed.message, sampleInput.message);
  assert.deepEqual(parsed.current, sampleInput.current);
  assert.ok(Array.isArray(parsed.availableModels));
  assert.equal(parsed.availableModels.length, 2);
  assert.equal(parsed.availableModels[0].modelId, "gpt-5.4-mini");
  // The reasoningGuidance block tells the model how to pick levels.
  assert.ok(typeof parsed.reasoningGuidance === "object");
});

test("buildNormalChatRecommenderPrompt returns a system + user pair", () => {
  const prompt = buildNormalChatRecommenderPrompt(sampleInput);
  assert.equal(prompt.system, NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT);
  // The user prompt must round-trip through JSON.parse.
  assert.doesNotThrow(() => JSON.parse(prompt.user));
});

test("buildNormalChatRecommenderPrompt accepts an empty availableModels list", () => {
  // Defense-in-depth: the Settings UI may render the preview against
  // a freshly-registered deployment with no discovered models yet.
  const prompt = buildNormalChatRecommenderPrompt({
    ...sampleInput,
    availableModels: [],
  });
  const parsed = JSON.parse(prompt.user);
  assert.deepEqual(parsed.availableModels, []);
});

test("NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT does not single out Codex as out-of-scope", () => {
  // Codex subscription models are selectable in the chat picker (the
  // chat composer uses the Codex chat pane), so the recommender must
  // be willing to recommend them. The contract is locked in so a
  // future refactor that explicitly excludes Codex (e.g. "Do not
  // choose Codex") regresses this test.
  assert.doesNotMatch(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /Do not choose Codex/i);
  assert.doesNotMatch(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /never Codex/i);
});

test("NormalChatAvailableModel shape accepts a Codex entry with codex_chatgpt accessPath", () => {
  // Round-trip a Codex subscription row through the JSON user prompt.
  // The recommender route may include Codex in availableModels; the
  // shape and prompt builder must accept it without losing fields.
  const prompt = buildNormalChatRecommenderPrompt({
    ...sampleInput,
    availableModels: [
      {
        provider: "codex",
        modelId: "codex:gpt-5.4-mini",
        displayLabel: "Codex · GPT-5.4 Mini",
        supportsReasoningControls: false,
        allowedReasoningLevels: [],
        enabled: true,
        accessPath: "codex_chatgpt",
        tier: "cheap",
      },
    ],
  });
  const parsed = JSON.parse(prompt.user);
  assert.equal(parsed.availableModels.length, 1);
  assert.equal(parsed.availableModels[0].provider, "codex");
  assert.equal(parsed.availableModels[0].accessPath, "codex_chatgpt");
  assert.equal(parsed.availableModels[0].supportsReasoningControls, false);
  assert.deepEqual(parsed.availableModels[0].allowedReasoningLevels, []);
});
