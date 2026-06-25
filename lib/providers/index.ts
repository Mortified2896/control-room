import {
  DEFAULT_REASONING_LEVEL,
  ROUTER_DEFAULT_MODEL_ID,
  openaiProvider,
  getOpenAIModels,
  getOpenAIModelMeta,
  isOpenAIEnabled,
} from "./openai";
import type {
  ModelMeta,
  ModelOption,
  ModelsResponse,
  ProviderId,
  ResolveResult,
  RouterAllowlistEntry,
} from "./types";

const minimaxProvider: { id: ProviderId; label: string; disabledReason: string } = {
  id: "minimax",
  label: "MiniMax",
  disabledReason: "MINIMAX_API_KEY is not configured",
};

const MINIMAX_MODEL = { id: "minimax-disabled", label: "MiniMax" };

function getMiniMaxModels(): ModelOption[] {
  return [
    {
      providerId: minimaxProvider.id,
      providerLabel: minimaxProvider.label,
      modelId: MINIMAX_MODEL.id,
      modelLabel: MINIMAX_MODEL.label,
      enabled: false,
      reason: minimaxProvider.disabledReason,
      reasoningLevels: [],
      tier: "cheap",
    },
  ];
}

export function getAvailableModels(): ModelsResponse {
  const models: ModelOption[] = [...getOpenAIModels(), ...getMiniMaxModels()];
  const firstEnabled = models.find((m) => m.enabled);
  return {
    models,
    defaultModelId: firstEnabled ? firstEnabled.modelId : null,
    defaultReasoningLevel: DEFAULT_REASONING_LEVEL,
  };
}

function findModel(modelId: string): ModelOption | undefined {
  return getAvailableModels().models.find((m) => m.modelId === modelId);
}

export function resolveModel(modelId: string | undefined): ResolveResult {
  const all = getAvailableModels().models;
  const allowedIds = all.map((m) => m.modelId);

  if (!modelId) {
    const firstEnabled = all.find((m) => m.enabled);
    if (firstEnabled) {
      return {
        ok: true,
        resolved: {
          providerId: firstEnabled.providerId,
          modelId: firstEnabled.modelId,
        },
      };
    }
    return { ok: false, error: { kind: "no_models_available" } };
  }

  const found = findModel(modelId);
  if (!found) {
    return {
      ok: false,
      error: { kind: "unknown_model", modelId, allowedIds },
    };
  }

  if (!found.enabled) {
    return {
      ok: false,
      error: {
        kind: "provider_disabled",
        providerId: found.providerId,
        reason: found.reason ?? "Provider is not configured",
      },
    };
  }

  if (found.providerId === openaiProvider.id && !isOpenAIEnabled()) {
    return {
      ok: false,
      error: {
        kind: "provider_disabled",
        providerId: openaiProvider.id,
        reason: openaiProvider.disabledReason,
      },
    };
  }

  return {
    ok: true,
    resolved: { providerId: found.providerId, modelId: found.modelId },
  };
}

/**
 * Canonical metadata for a model id, across all providers in the registry.
 * Returns `null` for ids the build does not recognize — the router uses this
 * to reject disallowed model names before they reach the chat layer.
 */
export function getModelMeta(modelId: string): ModelMeta | null {
  return getOpenAIModelMeta(modelId);
}

/**
 * The default model the router itself uses for its cheap LLM recommendation
 * call. Exposed via `lib/providers` so the chat route and the router graph
 * agree on the same constant.
 */
export function getDefaultRouterModelId(): string {
  return ROUTER_DEFAULT_MODEL_ID;
}

/**
 * List the (modelId, reasoningLevel) pairs the router is allowed to pick
 * from in this build.
 *
 * This function is intentionally **pure and provider-enabled-agnostic**: it
 * enumerates the registered OpenAI model metadata directly, so the router
 * allowlist is the same regardless of whether `OPENAI_API_KEY` is set at
 * process start. Whether the router is *actually allowed* to call a model
 * at runtime is a separate, chat-route concern — see `resolveModel` and
 * `getModelMeta` for the provider-availability check.
 *
 * - When `allowExpensive === false`, expensive-tier models are filtered out.
 * - Cheap-tier models are always allowed.
 *
 * The dynamic policy (long-prompt exclusion, etc.) is layered on top in
 * `lib/router/policy.ts`.
 */
export function listRouterAllowedPool(
  allowExpensive: boolean,
): ReadonlyArray<RouterAllowlistEntry> {
  const out: RouterAllowlistEntry[] = [];
  // Pull from the static registry, not from `getAvailableModels()` — that
  // function is gated on `process.env.OPENAI_API_KEY` for `enabled`, which
  // would make the allowlist (and therefore the router) nondeterministic
  // across test runs.
  const all = getOpenAIModels();
  for (const m of all) {
    if (m.providerId !== "openai") continue; // router scope is OpenAI in MVP
    if (m.tier === "expensive" && !allowExpensive) continue;
    for (const lvl of m.reasoningLevels) {
      out.push({ modelId: m.modelId, reasoningLevel: lvl, tier: m.tier });
    }
  }
  return out;
}
