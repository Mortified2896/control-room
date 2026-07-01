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
//
// Contract (pinned by `normal-chat-prompts.test.ts`):
//
//   - Output MUST be exactly ONE JSON object — no markdown fences,
//     no prose, no comments, no wrapper keys, no array.
//   - The object MUST contain EXACTLY these top-level fields:
//       recommendedModelId          (string, required)
//       recommendedProvider         (string, required)
//       recommendedReasoningLevel   (string|null, required)
//       reasoning                   (string, required, 1-200 chars)
//       alternatives                (array, required)
//   - Aliases are FORBIDDEN and will fail validation:
//       "modelId"          ≠ "recommendedModelId"
//       "provider"         ≠ "recommendedProvider"
//       "reasoningLevel"   ≠ "recommendedReasoningLevel"
//   - `recommendedReasoningLevel` MUST be null when the chosen
//     model advertises `supportsReasoningControls: false`.
//   - `alternatives` items MUST use the same alias set:
//       modelId                    (NOT "selectedModelId" etc.)
//       provider                   (NOT "recommendedProvider" etc.)
//       recommendedReasoningLevel  (NOT "reasoningLevel")
//       reason                     (string, required)
//
// The miniMax-M3 fallback engine in particular is known to drift
// into alias names (`modelId`, `provider`, `reasoningLevel`) when
// the prompt is permissive. The explicit field-name list + alias
// call-out + minimal valid example pins that drift in the prompt
// itself so we never have to relax the zod schema downstream.

export const NORMAL_CHAT_RECOMMENDER_SYSTEM_PROMPT =
  "You are the Control Room normal-chat recommender. You pick ONE answer model and reasoning level for the user's chat message from the provided list. " +
  "You do NOT answer the user. You do NOT execute anything. You ONLY return a single JSON object.\n\n" +
  "Output contract (strict — output that does not match this shape will be rejected and the request will fail):\n" +
  "- Return EXACTLY ONE JSON object. No markdown fences, no prose, no comments, no wrapper keys, no array, no leading or trailing text.\n" +
  "- The object MUST contain ONLY these top-level fields, with EXACTLY these names:\n" +
  '  - "recommendedModelId"        (string, non-empty)\n' +
  '  - "recommendedProvider"       (string, non-empty)\n' +
  '  - "recommendedReasoningLevel" (string OR null; must be null when the chosen model does not support reasoning controls)\n' +
  '  - "reasoning"                 (string, 1-200 chars; short user-facing reason for the pick)\n' +
  '  - "alternatives"              (array; each item must have keys "modelId", "provider", "recommendedReasoningLevel", "reason")\n' +
  "- ALIASES ARE FORBIDDEN. The following WRONG field names will fail validation:\n" +
  '  - "modelId"          is NOT a substitute for "recommendedModelId".\n' +
  '  - "provider"         is NOT a substitute for "recommendedProvider".\n' +
  '  - "reasoningLevel"   is NOT a substitute for "recommendedReasoningLevel".\n' +
  "  Do not use any other naming variation.\n" +
  "- Reasoning policy: prefer cheaper/faster models for simple prompts; stronger models or higher reasoning for complex planning, debugging, architecture, multi-step reasoning, or high-stakes decisions.\n" +
  "- Do not prefer, preserve, or mention the currently selected manual chat model. Choose solely from the user message and the available-models list.\n" +
  '- If you cannot decide, return a best-guess pick in the exact required shape above — never return prose, never omit a required field.\n\n' +
  "Minimal valid example (use this exact shape — do not invent extra fields):\n" +
  "{\n" +
  '  "recommendedModelId": "MiniMax-M3",\n' +
  '  "recommendedProvider": "minimax",\n' +
  '  "recommendedReasoningLevel": null,\n' +
  '  "reasoning": "Cheap MiniMax subscription is enough for this conversational question.",\n' +
  '  "alternatives": []\n' +
  "}";

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
  /**
   * Diagnostic/manual selection context. Live recommendations intentionally
   * pass nulls here so the recommender does not anchor on the current manual
   * chat model.
   */
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
