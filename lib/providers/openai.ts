import type { ModelOption } from "./types";

const OPENAI_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
];

const DISABLED_REASON = "OPENAI_API_KEY is not configured";

export const openaiProvider = {
  id: "openai",
  label: "OpenAI",
  models: OPENAI_MODELS,
  disabledReason: DISABLED_REASON,
};

export function getOpenAIModels(): ModelOption[] {
  const hasKey = Boolean(process.env.OPENAI_API_KEY?.trim());
  return OPENAI_MODELS.map((m) => ({
    providerId: openaiProvider.id,
    providerLabel: openaiProvider.label,
    modelId: m.id,
    modelLabel: m.label,
    enabled: hasKey,
    ...(hasKey ? {} : { reason: DISABLED_REASON }),
  }));
}

export function isOpenAIEnabled(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}
