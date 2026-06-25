import { createOpenAI, openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { getMiniMaxConfig, MINIMAX_DISABLED_REASON } from "./minimax";
import type { ProviderId, ReasoningLevel, ResolvedModel } from "./types";

export type RuntimeProviderOptions = { openai: { reasoningEffort: ReasoningLevel } } | undefined;

export class ProviderConfigurationError extends Error {
  readonly providerId: ProviderId;

  constructor(providerId: ProviderId, message: string) {
    super(message);
    this.name = "ProviderConfigurationError";
    this.providerId = providerId;
  }
}

export function getRuntimeModel(resolved: ResolvedModel): LanguageModel {
  if (resolved.providerId === "openai") {
    return openai(resolved.modelId) as unknown as LanguageModel;
  }

  if (resolved.providerId === "minimax") {
    const config = getMiniMaxConfig();
    if (!config.apiKey) {
      throw new ProviderConfigurationError("minimax", MINIMAX_DISABLED_REASON);
    }
    const minimax = createOpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    return minimax(resolved.modelId) as unknown as LanguageModel;
  }

  const exhaustive: never = resolved.providerId;
  throw new ProviderConfigurationError(exhaustive, "Provider is not implemented.");
}

export function getRuntimeProviderOptions(
  resolved: ResolvedModel,
  reasoningLevel: ReasoningLevel,
): RuntimeProviderOptions {
  if (resolved.providerId === "openai") {
    return { openai: { reasoningEffort: reasoningLevel } };
  }
  return undefined;
}
