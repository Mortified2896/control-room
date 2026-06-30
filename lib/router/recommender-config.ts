import "server-only";

import { providerIdFromModelId } from "@/lib/router/schema";
import type { RouterSettings } from "@/lib/router/schema";

export type ConfiguredRecommenderRung = {
  source: "configured" | "configured_fallback";
  providerId: "openai" | "codex" | "minimax";
  modelId: string;
  reasoningLevel: string | undefined;
};

export function providerIdFromRecommenderModelId(modelId: string): "openai" | "codex" | "minimax" {
  const providerId = providerIdFromModelId(modelId);
  if (providerId === "codex" || providerId === "minimax") return providerId;
  return "openai";
}

/**
 * Single source of truth for the configured recommender call chain.
 * Product contract: primary configured recommender, then the one
 * configured recommender fallback if present; never append a hidden
 * provider/model default.
 */
export function buildConfiguredRecommenderChain(
  settings: Pick<
    RouterSettings,
    | "normalChatRecommenderModelId"
    | "normalChatRecommenderReasoningLevel"
    | "normalChatRecommenderFallbackModelId"
    | "normalChatRecommenderFallbackReasoningLevel"
  >,
): ConfiguredRecommenderRung[] {
  const chain: ConfiguredRecommenderRung[] = [];
  if (settings.normalChatRecommenderModelId) {
    chain.push({
      source: "configured",
      providerId: providerIdFromRecommenderModelId(settings.normalChatRecommenderModelId),
      modelId: settings.normalChatRecommenderModelId,
      reasoningLevel: settings.normalChatRecommenderReasoningLevel,
    });
  }
  if (settings.normalChatRecommenderFallbackModelId) {
    chain.push({
      source: "configured_fallback",
      providerId: providerIdFromRecommenderModelId(settings.normalChatRecommenderFallbackModelId),
      modelId: settings.normalChatRecommenderFallbackModelId,
      reasoningLevel: settings.normalChatRecommenderFallbackReasoningLevel ?? undefined,
    });
  }
  return chain.slice(0, 2);
}
