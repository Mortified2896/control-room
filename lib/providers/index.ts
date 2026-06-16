import { openaiProvider, getOpenAIModels, isOpenAIEnabled } from "./openai";
import type { ModelOption, ModelsResponse, ResolveResult } from "./types";

const minimaxProvider = {
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
    },
  ];
}

export function getAvailableModels(): ModelsResponse {
  const models: ModelOption[] = [...getOpenAIModels(), ...getMiniMaxModels()];
  const firstEnabled = models.find((m) => m.enabled);
  return {
    models,
    defaultModelId: firstEnabled ? firstEnabled.modelId : null,
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
