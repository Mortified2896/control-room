import type { ProposedSubscriptionFallback } from "@/lib/policy/no-api-billing-fallback";
import { enforceNoApiBillingFallback } from "@/lib/policy/no-api-billing-fallback";
import { getBillingSourceForProvider } from "@/lib/providers/billing-source";
import type { ReasoningCapability } from "@/lib/providers/capability";
import type {
  BillingSource,
  ModelMeta,
  ModelOption,
  ProviderId,
  ResolveResult,
  ResolvedModel,
  SelectionSource,
} from "@/lib/providers/types";
import type { ThinkingMode } from "@/lib/providers/runtime";

export type ChatLoudFailureKind =
  | "model_unavailable"
  | "provider_access_blocked"
  | "provider_configuration_error"
  | "reasoning_mode_unsupported"
  | "thinking_mode_unsupported"
  | "unknown_model"
  | "default_model_unavailable";

export type ChatLoudFailurePayload = {
  error: "chat_model_unavailable";
  kind: ChatLoudFailureKind;
  message: string;
  reason: string;
  requiresExplicitConfirmation: true;
  selection: {
    requestedModelId: string | null;
    requestedProviderId: ProviderId | null;
    selectionSource: SelectionSource;
    billingSource: BillingSource | null;
  };
  policy: "NO_API_BILLING_FALLBACK";
  proposedSubscriptionFallbacks: ReadonlyArray<ProposedSubscriptionFallback>;
};

export type ChatPreflightFailure = {
  ok: false;
  status: number;
  payload: ChatLoudFailurePayload;
};

export type ChatPreflightSuccess = {
  ok: true;
  resolved: ResolvedModel;
  selectedModel: ModelOption;
  selectionSource: SelectionSource;
  reasoningOption: string;
  thinkingMode: ThinkingMode;
  reasoningCapability: ReasoningCapability;
  metadata: {
    providerId: ProviderId;
    modelId: string;
    billingSource: BillingSource;
    selectionSource: SelectionSource;
    path: ModelOption["accessPath"];
  };
};

export type ChatPreflightResult = ChatPreflightSuccess | ChatPreflightFailure;

export function parseChatReasoningOption(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return "low";
}

export function parseChatThinkingMode(value: unknown): ThinkingMode {
  if (value == null || value === "") return "provider_default";
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return "__invalid__";
}

export function parseChatSelectionSource(value: unknown): SelectionSource {
  if (
    value === "user_explicit" ||
    value === "user_accepted" ||
    value === "project_default" ||
    value === "registry_default" ||
    value === "system_fallback"
  ) {
    return value;
  }
  return "registry_default";
}

export function buildChatLoudFailure(input: {
  kind: ChatLoudFailureKind;
  status?: number;
  message: string;
  reason?: string;
  requestedModelId: string | null;
  requestedProviderId: ProviderId | null;
  selectionSource: SelectionSource;
  billingSource: BillingSource | null;
  availableModels: ReadonlyArray<ModelOption>;
}): ChatPreflightFailure {
  const reason = input.reason ?? input.message;
  const proposedSubscriptionFallbacks =
    input.requestedModelId && input.requestedProviderId && input.billingSource
      ? subscriptionFallbackProposals({
          requestedModelId: input.requestedModelId,
          requestedProviderId: input.requestedProviderId,
          requestedBillingSource: input.billingSource,
          selectionSource: input.selectionSource,
          reason,
          availableModels: input.availableModels,
        })
      : [];

  return {
    ok: false,
    status: input.status ?? 409,
    payload: {
      error: "chat_model_unavailable",
      kind: input.kind,
      message: input.message,
      reason,
      requiresExplicitConfirmation: true,
      selection: {
        requestedModelId: input.requestedModelId,
        requestedProviderId: input.requestedProviderId,
        selectionSource: input.selectionSource,
        billingSource: input.billingSource,
      },
      policy: "NO_API_BILLING_FALLBACK",
      proposedSubscriptionFallbacks,
    },
  };
}

export function subscriptionFallbackProposals(input: {
  requestedModelId: string;
  requestedProviderId: ProviderId;
  requestedBillingSource: BillingSource;
  selectionSource: SelectionSource;
  reason: string;
  availableModels: ReadonlyArray<ModelOption>;
}): ReadonlyArray<ProposedSubscriptionFallback> {
  const candidates: ModelMeta[] = input.availableModels
    .filter((m) => m.enabled)
    .filter((m) => getBillingSourceForProvider(m.providerId, m.modelId) === "subscription")
    .map((m) => ({
      providerId: m.providerId,
      modelId: m.modelId,
      modelLabel: m.modelLabel,
      tier: m.tier,
      reasoningCapability: m.reasoningCapability,
      reasoningLevels: m.reasoningLevels,
      billingSource: "subscription" as const,
    }));

  return enforceNoApiBillingFallback({
    requested: {
      modelId: input.requestedModelId,
      providerId: input.requestedProviderId,
      billingSource: input.requestedBillingSource,
      selectionSource: input.selectionSource,
    },
    kind: "model_unavailable",
    reason: input.reason,
    candidates,
    registry: input.availableModels.map((m) => ({
      modelId: m.modelId,
      displayLabel: m.modelLabel,
    })),
  }).proposals;
}

const DEFAULT_MODEL_UNAVAILABLE_MESSAGE =
  "Your default model is hidden or unavailable. Re-enable it in Settings or choose another model.";

export function preflightChatModel(input: {
  modelId: string | null | undefined;
  reasoningOption: unknown;
  thinkingMode: unknown;
  selectionSource: unknown;
  availableModels: ReadonlyArray<ModelOption>;
  resolveModel: (modelId: string | undefined) => ResolveResult;
  getModelMeta: (modelId: string) => ModelMeta | null;
}): ChatPreflightResult {
  const selectionSource = parseChatSelectionSource(input.selectionSource);

  if (!input.modelId) {
    return buildChatLoudFailure({
      kind: "default_model_unavailable",
      status: 409,
      message: DEFAULT_MODEL_UNAVAILABLE_MESSAGE,
      requestedModelId: null,
      requestedProviderId: null,
      selectionSource,
      billingSource: null,
      availableModels: input.availableModels,
    });
  }

  const selected = input.availableModels.find((m) => m.modelId === input.modelId) ?? null;
  if (!selected) {
    return buildChatLoudFailure({
      kind: "model_unavailable",
      status: 409,
      message: DEFAULT_MODEL_UNAVAILABLE_MESSAGE,
      requestedModelId: input.modelId,
      requestedProviderId: null,
      selectionSource,
      billingSource: null,
      availableModels: input.availableModels,
    });
  }

  const requestedProviderId = selected.providerId;
  const requestedBillingSource = getBillingSourceForProvider(selected.providerId, selected.modelId);

  if (!selected.enabled) {
    return buildChatLoudFailure({
      kind: "model_unavailable",
      status: 409,
      message: selected.reason ?? DEFAULT_MODEL_UNAVAILABLE_MESSAGE,
      requestedModelId: selected.modelId,
      requestedProviderId,
      selectionSource,
      billingSource: requestedBillingSource,
      availableModels: input.availableModels,
    });
  }

  const resolved = input.resolveModel(input.modelId);
  if (!resolved.ok) {
    const err = resolved.error;
    return buildChatLoudFailure({
      kind: err.kind === "provider_disabled" ? "provider_access_blocked" : "unknown_model",
      status: err.kind === "unknown_model" ? 400 : 503,
      message:
        err.kind === "no_models_available"
          ? "No models are available. Configure a provider in Settings."
          : err.kind === "provider_disabled"
            ? err.reason
            : "The selected model is hidden, unavailable, or not configured. Re-enable it in Settings or choose another model.",
      requestedModelId: input.modelId,
      requestedProviderId,
      selectionSource,
      billingSource: requestedBillingSource,
      availableModels: input.availableModels,
    });
  }

  if (
    resolved.resolved.providerId !== requestedProviderId ||
    resolved.resolved.modelId !== selected.modelId ||
    resolved.resolved.billingSource !== requestedBillingSource
  ) {
    return buildChatLoudFailure({
      kind: "model_unavailable",
      status: 409,
      message:
        "Selected model resolution changed before execution. Control Room will not auto-substitute.",
      requestedModelId: selected.modelId,
      requestedProviderId,
      selectionSource,
      billingSource: requestedBillingSource,
      availableModels: input.availableModels,
    });
  }

  const reasoningOption = parseChatReasoningOption(input.reasoningOption);
  const thinkingMode = parseChatThinkingMode(input.thinkingMode);
  const meta = input.getModelMeta(resolved.resolved.modelId);
  const reasoningCapability =
    meta?.reasoningCapability ?? ({ kind: "unknown", control: "unknown" } as const);

  if (thinkingMode === "__invalid__") {
    return buildChatLoudFailure({
      kind: "thinking_mode_unsupported",
      status: 400,
      message: "Invalid thinking mode. Control Room will not silently use a provider default.",
      requestedModelId: resolved.resolved.modelId,
      requestedProviderId: resolved.resolved.providerId,
      selectionSource,
      billingSource: resolved.resolved.billingSource,
      availableModels: input.availableModels,
    });
  }

  if (
    reasoningCapability.kind === "thinking_budget" &&
    reasoningCapability.control === "supported" &&
    thinkingMode !== "provider_default" &&
    reasoningCapability.modes?.length &&
    !reasoningCapability.modes.some((m) => m.value === thinkingMode)
  ) {
    return buildChatLoudFailure({
      kind: "thinking_mode_unsupported",
      status: 400,
      message: `Thinking mode ${thinkingMode} is not supported by ${resolved.resolved.modelId}.`,
      requestedModelId: resolved.resolved.modelId,
      requestedProviderId: resolved.resolved.providerId,
      selectionSource,
      billingSource: resolved.resolved.billingSource,
      availableModels: input.availableModels,
    });
  }

  return {
    ok: true,
    resolved: resolved.resolved,
    selectedModel: selected,
    selectionSource,
    reasoningOption,
    thinkingMode,
    reasoningCapability,
    metadata: {
      providerId: resolved.resolved.providerId,
      modelId: resolved.resolved.modelId,
      billingSource: resolved.resolved.billingSource,
      selectionSource,
      path: selected.accessPath,
    },
  };
}

export function chatFailureFromProviderIssue(input: {
  kind: ChatLoudFailureKind;
  status?: number;
  message: string;
  preflight: ChatPreflightSuccess;
  availableModels: ReadonlyArray<ModelOption>;
}): ChatPreflightFailure {
  return buildChatLoudFailure({
    kind: input.kind,
    status: input.status,
    message: input.message,
    requestedModelId: input.preflight.resolved.modelId,
    requestedProviderId: input.preflight.resolved.providerId,
    selectionSource: input.preflight.selectionSource,
    billingSource: input.preflight.resolved.billingSource,
    availableModels: input.availableModels,
  });
}
