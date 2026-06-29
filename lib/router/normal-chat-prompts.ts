/**
 * Normal-chat recommender prompts.
 *
 * The "Recommend model" toggle in the chat composer consults a cheap
 * recommender model before each send when enabled. This file holds the
 * prompt construction for that recommender so the API route and the
 * Settings UI can share a single source of truth. The Settings UI
 * shows the same prompt that the route sends — no drift between "what
 * the user sees in Settings" and "what the model actually sees".
 *
 * The system prompt is a tight brief that names the role, restates
 * the safety constraints, and tells the recommender to only choose
 * from the list provided. The user prompt is a small JSON payload
 * describing the user's message, the currently-selected model, and
 * the available-models list.
 */
// Provider-native reasoning values (e.g. Codex `xhigh`, MiniMax
// `adaptive`) flow through verbatim. The runtime adapter validates
// against the model's `reasoningCapability.options` before
// forwarding to the provider.

export const NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT =
  "You recommend the answer model and reasoning level for a normal chat message in Control Room. " +
  "Only choose enabled models from the provided list. The list may include OpenAI API models, MiniMax models, AND Codex subscription models — all three are valid chat providers in Control Room, so treat them equally. " +
  "Prefer cheaper/faster models for simple prompts; stronger models or higher reasoning for complex planning, debugging, architecture, multi-step reasoning, or high-stakes decisions. " +
  "If the current model is appropriate, recommend keeping it. Reasoning must be null for models without reasoning controls. Keep reasons short and practical.";

/**
 * A model the recommender is allowed to recommend. Subset of the full
 * chat-picker registry, filtered to enabled entries (OpenAI API,
 * MiniMax, Codex subscription — all three are valid chat providers in
 * Control Room).
 */
export type NormalChatAvailableModel = {
  provider: string;
  modelId: string;
  displayLabel: string;
  supportsReasoningControls: boolean;
  /** Provider-native option values (e.g. `"low"`, `"xhigh"`). */
  allowedReasoningLevels: ReadonlyArray<string>;
  enabled: boolean;
  accessPath: "openai_api" | "minimax_api" | "codex_chatgpt" | null;
  tier: "cheap" | "expensive" | "standard" | "unknown";
};

export type NormalChatRecommenderInput = {
  mode: "normal_chat";
  /** The user's latest draft message (or, for live runs, the message they just sent). */
  message: string;
  /** The user's currently-selected chat model + reasoning level, if any. */
  current: {
    modelId: string | null;
    provider: string | null;
    /** Provider-native reasoning-effort value the user picked (or null). */
    reasoningLevel: string | null;
  };
  /** The allowlist the recommender can choose from. */
  availableModels: ReadonlyArray<NormalChatAvailableModel>;
};

/**
 * Build the JSON user-prompt body. The runtime stringifies this to
 * pass to the model as a single user message; the Settings UI uses
 * the same builder with example values to render a faithful preview.
 */
export function buildNormalChatRecommenderUserPrompt(input: NormalChatRecommenderInput): string {
  return JSON.stringify({
    mode: input.mode,
    message: input.message,
    current: {
      modelId: input.current.modelId,
      provider: input.current.provider,
      reasoningLevel: input.current.reasoningLevel ?? null,
    },
    availableModels: input.availableModels,
    reasoningGuidance: {
      simple: ["low"],
      normalAnalysisOrPlanning: ["medium"],
      complexDebuggingArchitectureImportantDecisions: ["high"],
    },
  });
}

/**
 * Build the full { system, user } prompt pair for the normal-chat
 * recommender. Used by both the API route (live calls) and the
 * Settings UI (read-only preview).
 */
export function buildNormalChatRecommenderPrompt(input: NormalChatRecommenderInput): {
  system: string;
  user: string;
} {
  return {
    system: NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT,
    user: buildNormalChatRecommenderUserPrompt(input),
  };
}
