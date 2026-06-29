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

test("NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT treats Codex as a valid chat provider", () => {
  // Codex subscription models are selectable in the chat picker (the
  // chat composer uses the Codex chat pane), so the recommender must
  // be willing to recommend them. The old prompt explicitly excluded
  // Codex; the new one explicitly includes it. This test locks the
  // contract in so a future refactor can't silently regress.
  assert.match(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /Codex subscription models/i);
  assert.doesNotMatch(NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT, /Do not choose Codex/i);
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
