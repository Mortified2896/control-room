import type { ModelMeta, ModelOption } from "./types";

export const MINIMAX_DEFAULT_BASE_URL = "https://api.minimax.io/v1";
export const MINIMAX_DEFAULT_MODEL_ID = "MiniMax-M3";
export const MINIMAX_DISABLED_REASON = "MINIMAX_API_KEY is not configured.";

export const minimaxProvider = {
  id: "minimax" as const,
  label: "MiniMax",
  disabledReason: MINIMAX_DISABLED_REASON,
};

export function getMiniMaxConfig(): {
  apiKeySet: boolean;
  apiKey: string | undefined;
  baseURL: string;
  defaultModel: string;
} {
  const apiKey = process.env.MINIMAX_API_KEY?.trim() || undefined;
  return {
    apiKeySet: Boolean(apiKey),
    apiKey,
    baseURL: process.env.MINIMAX_BASE_URL?.trim() || MINIMAX_DEFAULT_BASE_URL,
    defaultModel: process.env.MINIMAX_DEFAULT_MODEL?.trim() || MINIMAX_DEFAULT_MODEL_ID,
  };
}

export function isMiniMaxEnabled(): boolean {
  return getMiniMaxConfig().apiKeySet;
}

export function getMiniMaxModels(): ModelOption[] {
  const config = getMiniMaxConfig();
  return [
    {
      providerId: minimaxProvider.id,
      providerLabel: "MiniMax API",
      modelId: config.defaultModel,
      modelLabel: `MiniMax API · ${config.defaultModel}`,
      enabled: config.apiKeySet,
      accessPath: "minimax_api",
      billingLabel: "MiniMax token plan",
      capabilityKind: "model_provider",
      description:
        "Access: MiniMax API key · MiniMax token plan/subscription. Direct MiniMax API call.",
      ...(config.apiKeySet ? {} : { reason: MINIMAX_DISABLED_REASON }),
      reasoningLevels: [],
      tier: "cheap",
    },
  ];
}

export function getMiniMaxModelMeta(modelId: string): ModelMeta | null {
  const config = getMiniMaxConfig();
  if (modelId !== config.defaultModel) return null;
  return {
    providerId: minimaxProvider.id,
    modelId: config.defaultModel,
    modelLabel: config.defaultModel,
    tier: "cheap",
    reasoningLevels: [],
  };
}
