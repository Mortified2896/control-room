import type { ModelMeta, ModelOption, ReasoningLevel } from "./types";

/**
 * Canonical OpenAI model metadata.
 *
 * This is the single source of truth for:
 * - which model ids ship in this build,
 * - what reasoning levels each model is allowed to be paired with,
 * - and the cost tier that drives the router's safety/budget guards.
 *
 * If a new model is added here, the chat route's `resolveModel` continues to
 * work unchanged because it consumes the runtime `OPENAI_MODELS` list below;
 * the router also picks it up automatically via `getModelMeta` /
 * `listRouterAllowedPool`.
 *
 * Notes on tier assignment:
 * - `gpt-5.4-mini` is the cheap tier — also the default router model.
 * - `gpt-5.5` is the expensive tier — off by default; opt-in via router
 *   settings (`allowExpensiveModels`).
 */
type OpenAIModelMeta = ModelMeta;

const OPENAI_MODEL_METAS: ReadonlyArray<OpenAIModelMeta> = [
  {
    providerId: "openai",
    modelId: "gpt-5.4-mini",
    modelLabel: "GPT-5.4 Mini",
    tier: "cheap",
    reasoningLevels: ["low", "medium"],
  },
  {
    providerId: "openai",
    modelId: "gpt-5.5",
    modelLabel: "GPT-5.5",
    tier: "expensive",
    reasoningLevels: ["low", "medium", "high"],
  },
];

const OPENAI_MODELS: ReadonlyArray<{ id: string; label: string }> = OPENAI_MODEL_METAS.map((m) => ({
  id: m.modelId,
  label: m.modelLabel,
}));

const DISABLED_REASON = "OPENAI_API_KEY is not configured";

export const openaiProvider = {
  id: "openai",
  label: "OpenAI",
  models: OPENAI_MODELS,
  disabledReason: DISABLED_REASON,
};

export function getOpenAIModels(): ModelOption[] {
  const hasKey = Boolean(process.env.OPENAI_API_KEY?.trim());
  return OPENAI_MODEL_METAS.map((m) => ({
    providerId: m.providerId,
    providerLabel: openaiProvider.label,
    modelId: m.modelId,
    modelLabel: m.modelLabel,
    enabled: hasKey,
    reasoningLevels: m.reasoningLevels,
    tier: m.tier,
    ...(hasKey ? {} : { reason: DISABLED_REASON }),
  }));
}

export function isOpenAIEnabled(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

/**
 * Look up the canonical metadata for a model id. Returns `null` for ids the
 * build does not recognize — callers should treat `null` as "this model is
 * not part of the registry" and refuse to use it (the router uses this to
 * reject stale or disallowed model names).
 */
export function getOpenAIModelMeta(modelId: string): ModelMeta | null {
  const found = OPENAI_MODEL_METAS.find((m) => m.modelId === modelId);
  return found ? { ...found } : null;
}

/**
 * The router's default recommender model. The router is required to be cheap
 * by the brief — this is intentionally a cheap-tier model and is also the
 * model we use for low-reasoning Side A defaults in tests.
 */
export const ROUTER_DEFAULT_MODEL_ID = "gpt-5.4-mini";

/**
 * The reasoning level the router itself uses for its own GPT-5.4 Mini call.
 * Kept low because the recommender only emits a small JSON payload.
 */
export const ROUTER_OWN_REASONING_LEVEL: ReasoningLevel = "low";

/**
 * The reasoning level the chat UI defaults to before the user picks one.
 * Cheap-tier mini only supports low/medium; "low" is the safe default that
 * works on every model in the registry.
 */
export const DEFAULT_REASONING_LEVEL: ReasoningLevel = "low";
