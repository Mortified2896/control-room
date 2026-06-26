import type { ModelMeta, ModelOption } from "./types";
import { getMiniMaxDiscoverySnapshot } from "@/lib/repo/minimax-models-discovery";

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

function toMiniMaxModelOption(modelId: string, enabled: boolean, reason?: string): ModelOption {
  return {
    providerId: minimaxProvider.id,
    providerLabel: "MiniMax API",
    modelId,
    modelLabel: `MiniMax API · ${modelId}`,
    enabled,
    accessPath: "minimax_api",
    billingLabel: "MiniMax token plan",
    capabilityKind: "model_provider",
    description:
      "Access: MiniMax API key · MiniMax token plan/subscription. Direct MiniMax API call.",
    ...(reason ? { reason } : {}),
    reasoningLevels: [],
    tier: "cheap",
  };
}

export function getMiniMaxModels(): ModelOption[] {
  const config = getMiniMaxConfig();
  return [
    toMiniMaxModelOption(
      config.defaultModel,
      config.apiKeySet,
      config.apiKeySet ? undefined : MINIMAX_DISABLED_REASON,
    ),
  ];
}

export async function getDiscoveredMiniMaxModels(): Promise<ModelOption[]> {
  const config = getMiniMaxConfig();
  const snapshot = await getMiniMaxDiscoverySnapshot();
  const ids = snapshot.modelIds.length > 0 ? snapshot.modelIds : [config.defaultModel];
  const reason = !config.apiKeySet
    ? MINIMAX_DISABLED_REASON
    : snapshot.modelIds.length === 0
      ? "MiniMax discovery has no cached models; using fallback MiniMax-M3."
      : snapshot.errorMessage
        ? `MiniMax discovery failed; using last cached models. ${snapshot.errorMessage}`
        : undefined;
  return [...new Set(ids)].sort().map((id) => toMiniMaxModelOption(id, config.apiKeySet, reason));
}

export function getMiniMaxModelMeta(modelId: string): ModelMeta | null {
  const config = getMiniMaxConfig();
  if (modelId !== config.defaultModel) return null;
  return {
    providerId: minimaxProvider.id,
    modelId,
    modelLabel: modelId,
    tier: "cheap",
    reasoningLevels: [],
  };
}
