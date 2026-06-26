import type { ModelMeta, ModelOption, ReasoningLevel } from "./types";
import { getStaticOpenAIModelAlias, listStaticOpenAIModelAliases } from "./openai-static";

/**
 * Canonical OpenAI model metadata.
 *
 * This is the single source of truth for:
 * - which model ids ship in this build,
 * - what reasoning levels each model is allowed to be paired with,
 * - and the cost tier that drives the router's safety/budget guards.
 *
 * The data lives in `lib/providers/openai-static.ts` (the alias map) so
 * both the synchronous router-graph code path AND the async dynamic
 * registry (`lib/providers/registry.ts`) consume the same source. The
 * `OPENAI_MODEL_METAS` array below is derived from that alias map for
 * backward compatibility with the cost table lookups in
 * `lib/router/policy.ts` and the legacy `getOpenAIModelMeta` resolver.
 *
 * Notes on tier assignment:
 * - `gpt-5.4-mini` is the cheap tier — also the default router model.
 * - `gpt-5.5` is the expensive tier — off by default; opt-in via router
 *   settings (`allowExpensiveModels`).
 */
type OpenAIModelMeta = ModelMeta;

function deriveStaticMetas(): ReadonlyArray<OpenAIModelMeta> {
  return listStaticOpenAIModelAliases()
    .filter(([, alias]) => alias.tier !== undefined)
    .map(([modelId, alias]) => ({
      providerId: "openai" as const,
      modelId,
      modelLabel: alias.label,
      tier: alias.tier,
      reasoningLevels: alias.reasoningLevels,
    }));
}

const OPENAI_MODEL_METAS: ReadonlyArray<OpenAIModelMeta> = deriveStaticMetas();

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
    providerLabel: "OpenAI API",
    modelId: m.modelId,
    modelLabel: `OpenAI API · ${m.modelLabel}`,
    enabled: hasKey,
    accessPath: "openai_api",
    billingLabel: "API billed",
    capabilityKind: "model_provider",
    description:
      "Access: OpenAI API key · API billed. Direct OpenAI API call; not subscription-backed.",
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
  const alias = getStaticOpenAIModelAlias(modelId);
  if (!alias) return null;
  return {
    providerId: "openai",
    modelId,
    modelLabel: alias.label,
    tier: alias.tier,
    reasoningLevels: alias.reasoningLevels,
  };
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
