import type { ModelMeta, ModelOption } from "./types";
import type { ReasoningCapability } from "./capability";
import {
  getEffectiveReasoningLevels,
  MINIMAX_THINKING_MODE_VALUES,
  thinkingBudgetCapability,
} from "./capability";
import { getMiniMaxDiscoverySnapshot } from "@/lib/repo/minimax-models-discovery";
import type { SupportedExecutionTarget } from "./codex-catalog";

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

/**
 * Capability for MiniMax M3 — the well-known default model. M3
 * exposes provider-native thinking controls that do NOT fit the
 * OpenAI `reasoning_effort` shape.
 *
 * We do NOT force MiniMax into the OpenAI-style `low | medium | high`
 * effort-level enum — the provider-native mode values
 * (`provider_default`, `adaptive`, `enabled`, `disabled`) flow
 * through the runtime adapter verbatim and the UI renders the raw
 * names. The runtime adapter (`getRuntimeProviderOptions` in
 * `runtime.ts`) translates the user's pick into the MiniMax /
 * OpenRouter-compatible `reasoning` payload.
 */
export const MINIMAX_M3_CAPABILITY: ReasoningCapability = thinkingBudgetCapability("supported", {
  modes: MINIMAX_THINKING_MODE_VALUES.map((v) => ({ value: v })),
  defaultMode: "provider_default",
  supportsEnabled: true,
  supportsTokenBudget: true,
  supportsExclude: true,
  source: "static",
});

/**
 * Capability for a discovered MiniMax model id we do not have static
 * metadata for. We know the *family* is thinking-budget-capable
 * (because the M3 family is), but the exact set of provider-native
 * modes is unknown. The UI must NOT render a fake effort-level
 * dropdown; it shows a "thinking capability: unknown" notice instead.
 */
export function capabilityForUnknownMiniMaxModel(): ReasoningCapability {
  return thinkingBudgetCapability("unknown", { source: "static" });
}

function toMiniMaxModelOption(
  modelId: string,
  enabled: boolean,
  capability: ReasoningCapability,
  reason?: string,
  supportedExecutionTargets?: ReadonlyArray<SupportedExecutionTarget>,
): ModelOption {
  const targets = supportedExecutionTargets ?? defaultMiniMaxTargets(modelId);
  const option: ModelOption = {
    providerId: minimaxProvider.id,
    providerLabel: "MiniMax subscription",
    modelId,
    modelLabel: `MiniMax-M3 · MiniMax subscription`.replace("MiniMax-M3", modelId),
    enabled,
    accessPath: "minimax_api",
    billingLabel: "MiniMax subscription",
    capabilityKind: "model_provider",
    description:
      "Access: MiniMax subscription. The env key is the subscription secret, not an API-billed per-token meter. This provider is never an API-billed fallback under the no-API-billing-fallback policy.",
    reasoningCapability: capability,
    reasoningLevels: getEffectiveReasoningLevels(capability),
    tier: "cheap",
    // Surface the execution targets on the chat-picker DTO so the
    // harness registry can filter eligible model ids without
    // consulting a hard-coded allowlist. The default for the M3
    // model id is `[chat_model, minimax_cli]` — the harness registry
    // refuses to recommend MiniMax-M3 against `codex_cli`, and Codex
    // CLI's catalog explicitly excludes `MiniMax-M3`.
    supportedExecutionTargets: targets,
    // MiniMax M3 advertises thinking-budget modes today; from the
    // harness approval card's perspective the M3 model "supports"
    // reasoning controls even though the CLI surface does not
    // (yet) accept a reasoning knob. We report `true` here so the
    // registry UI doesn't downgrade the row.
    supportsReasoningLevels: true,
    // MiniMax models do not support vision / image input.
    vision: false,
  };
  if (reason) {
    option.reason = reason;
  }
  return option;
}

/**
 * Default execution targets per MiniMax model id. `MiniMax-M3` is the
 * only MiniMax catalog row today and it supports BOTH the chat path
 * AND the MiniMax CLI harness. Future MiniMax ids inherit the same
 * defaults so the harness registry can pick them up without a code
 * change.
 */
function defaultMiniMaxTargets(modelId: string): ReadonlyArray<SupportedExecutionTarget> {
  if (modelId === "MiniMax-M3") return ["chat_model", "minimax_cli"];
  // Discovered-only MiniMax ids inherit the same dual-target default
  // because the family is uniformly harness-eligible; the registry
  // rejects any model not in the harness's `allowedModelIds`.
  return ["chat_model", "minimax_cli"];
}

export function getMiniMaxModels(): ModelOption[] {
  const config = getMiniMaxConfig();
  return [
    toMiniMaxModelOption(
      config.defaultModel,
      config.apiKeySet,
      MINIMAX_M3_CAPABILITY,
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
  return [...new Set(ids)].sort().map((id) =>
    toMiniMaxModelOption(
      id,
      config.apiKeySet,
      // Default model id (`MiniMax-M3`) gets the M3 capability we know;
      // any other discovered id is treated as model_dependent — we
      // know the family but not the exact surface, so the UI must
      // show a capability-aware control instead of a fake dropdown.
      id === config.defaultModel ? MINIMAX_M3_CAPABILITY : capabilityForUnknownMiniMaxModel(),
      reason,
    ),
  );
}

export function getMiniMaxModelMeta(modelId: string): ModelMeta | null {
  const config = getMiniMaxConfig();
  if (modelId !== config.defaultModel) return null;
  return {
    providerId: minimaxProvider.id,
    modelId,
    modelLabel: modelId,
    tier: "cheap",
    reasoningCapability: MINIMAX_M3_CAPABILITY,
    reasoningLevels: getEffectiveReasoningLevels(MINIMAX_M3_CAPABILITY),
    billingSource: "subscription",
    // MiniMax catalog row — both the chat path AND the MiniMax CLI
    // harness target. The harness registry reads this field to
    // decide whether `minimax_cli` may run against this model id.
    supportedExecutionTargets: defaultMiniMaxTargets(modelId),
    supportsReasoningLevels: true,
  };
}
