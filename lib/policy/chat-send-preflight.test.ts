import test from "node:test";
import assert from "node:assert/strict";

import {
  chatFailureFromProviderIssue,
  preflightChatModel,
  subscriptionFallbackProposals,
} from "./chat-send-preflight";
import type { ModelMeta, ModelOption, ProviderId, ResolveResult } from "@/lib/providers/types";
import type { ReasoningCapability } from "@/lib/providers/capability";

const noReasoning = { kind: "none", control: "unsupported" } as const;
const thinkingBudget: ReasoningCapability = {
  kind: "thinking_budget",
  control: "supported",
  modes: [{ value: "provider_default" }, { value: "enabled" }, { value: "disabled" }],
  defaultMode: "provider_default",
  supportsEnabled: true,
};
const effortLevels: ReasoningCapability = {
  kind: "effort_levels",
  control: "supported",
  options: [{ value: "low" }, { value: "medium" }],
  defaultOption: "low",
};

function option(input: {
  providerId: ProviderId;
  modelId: string;
  enabled?: boolean;
  reason?: string;
  capability?: ReasoningCapability;
}): ModelOption {
  const isOpenAI = input.providerId === "openai";
  const isMiniMax = input.providerId === "minimax";
  const supportedExecutionTargets = isOpenAI
    ? (["chat_model"] as const)
    : isMiniMax
      ? (["chat_model", "minimax_cli"] as const)
      : (["codex_cli"] as const);
  return {
    providerId: input.providerId,
    providerLabel: isOpenAI
      ? "OpenAI API billing"
      : isMiniMax
        ? "MiniMax subscription"
        : "Codex subscription",
    modelId: input.modelId,
    modelLabel: input.modelId,
    enabled: input.enabled ?? true,
    ...(input.reason ? { reason: input.reason } : {}),
    accessPath: isOpenAI ? "openai_api" : isMiniMax ? "minimax_api" : "codex_chatgpt",
    billingLabel: isOpenAI
      ? "OpenAI API billing"
      : isMiniMax
        ? "MiniMax subscription"
        : "Codex subscription",
    capabilityKind: input.providerId === "codex" ? "agent_backend" : "model_provider",
    description: input.modelId,
    reasoningCapability: input.capability ?? (isMiniMax ? thinkingBudget : noReasoning),
    reasoningLevels: input.capability?.kind === "effort_levels" ? ["low", "medium"] : [],
    tier: "cheap",
    supportedExecutionTargets,
    supportsReasoningLevels: input.capability?.kind === "effort_levels",
  };
}

function meta(input: {
  providerId: ProviderId;
  modelId: string;
  capability?: ReasoningCapability;
}): ModelMeta {
  const billingSource = input.providerId === "openai" ? "api_billing" : "subscription";
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    modelLabel: input.modelId,
    tier: "cheap",
    reasoningCapability:
      input.capability ?? (input.providerId === "minimax" ? thinkingBudget : noReasoning),
    reasoningLevels: input.capability?.kind === "effort_levels" ? ["low", "medium"] : [],
    billingSource,
  };
}

function resolver(
  models: ReadonlyArray<ModelOption>,
): (modelId: string | undefined) => ResolveResult {
  return (modelId) => {
    const found = models.find((m) => m.modelId === modelId && m.enabled);
    if (!modelId || !found) {
      return {
        ok: false,
        error: { kind: "unknown_model", modelId: modelId ?? "", allowedIds: [] },
      };
    }
    return {
      ok: true,
      resolved: {
        providerId: found.providerId,
        modelId: found.modelId,
        billingSource: found.providerId === "openai" ? "api_billing" : "subscription",
      },
    };
  };
}

function metaLookup(models: ReadonlyArray<ModelOption>): (modelId: string) => ModelMeta | null {
  return (modelId) => {
    const found = models.find((m) => m.modelId === modelId);
    return found
      ? meta({
          providerId: found.providerId,
          modelId: found.modelId,
          capability: found.reasoningCapability,
        })
      : null;
  };
}

const baseModels = [
  option({ providerId: "codex", modelId: "codex:gpt-5.4-mini" }),
  option({ providerId: "minimax", modelId: "MiniMax-M3" }),
  option({ providerId: "openai", modelId: "gpt-5.4-mini", capability: effortLevels }),
];

test("hidden selected model blocks loudly", () => {
  const res = preflightChatModel({
    modelId: "hidden-model",
    reasoningOption: "low",
    thinkingMode: "provider_default",
    selectionSource: "user_explicit",
    availableModels: baseModels,
    resolveModel: resolver(baseModels),
    getModelMeta: metaLookup(baseModels),
  });

  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 409);
    assert.equal(res.payload.error, "chat_model_unavailable");
    assert.equal(res.payload.kind, "model_unavailable");
    assert.equal(res.payload.requiresExplicitConfirmation, true);
  }
});

test("hidden persisted default does not silently become first visible model", () => {
  const res = preflightChatModel({
    modelId: undefined,
    reasoningOption: "low",
    thinkingMode: "provider_default",
    selectionSource: "registry_default",
    availableModels: baseModels,
    resolveModel: resolver(baseModels),
    getModelMeta: metaLookup(baseModels),
  });

  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.payload.kind, "default_model_unavailable");
    assert.equal(res.payload.selection.requestedModelId, null);
    assert.equal(res.payload.proposedSubscriptionFallbacks.length, 0);
    assert.match(res.payload.message, /default model is hidden or unavailable/);
  }
});

test("no visible models blocks loudly", () => {
  const res = preflightChatModel({
    modelId: null,
    reasoningOption: "low",
    thinkingMode: "provider_default",
    selectionSource: "registry_default",
    availableModels: [],
    resolveModel: resolver([]),
    getModelMeta: metaLookup([]),
  });

  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.payload.kind, "default_model_unavailable");
    assert.equal(res.payload.policy, "NO_API_BILLING_FALLBACK");
  }
});

test("invalid thinking mode is rejected, not coerced", () => {
  const res = preflightChatModel({
    modelId: "MiniMax-M3",
    reasoningOption: "low",
    thinkingMode: "adaptive-but-not-supported-here",
    selectionSource: "user_explicit",
    availableModels: baseModels,
    resolveModel: resolver(baseModels),
    getModelMeta: metaLookup(baseModels),
  });

  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 400);
    assert.equal(res.payload.kind, "thinking_mode_unsupported");
    assert.match(res.payload.message, /not supported/);
  }
});

test("missing credentials blocks loudly", () => {
  const models = [
    option({
      providerId: "minimax",
      modelId: "MiniMax-M3",
      enabled: false,
      reason: "MINIMAX_API_KEY is not configured.",
    }),
    option({ providerId: "codex", modelId: "codex:gpt-5.4-mini" }),
  ];
  const res = preflightChatModel({
    modelId: "MiniMax-M3",
    reasoningOption: "low",
    thinkingMode: "provider_default",
    selectionSource: "user_explicit",
    availableModels: models,
    resolveModel: resolver(models),
    getModelMeta: metaLookup(models),
  });

  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.payload.kind, "model_unavailable");
    assert.match(res.payload.message, /MINIMAX_API_KEY/);
    assert.equal(res.payload.selection.billingSource, "subscription");
  }
});

test("Codex subscription failure proposes MiniMax subscription, but does not execute it", () => {
  const preflight = preflightChatModel({
    modelId: "codex:gpt-5.4-mini",
    reasoningOption: "low",
    thinkingMode: "provider_default",
    selectionSource: "user_explicit",
    availableModels: baseModels,
    resolveModel: resolver(baseModels),
    getModelMeta: metaLookup(baseModels),
  });
  assert.equal(preflight.ok, true);
  if (!preflight.ok) return;

  const failure = chatFailureFromProviderIssue({
    kind: "provider_configuration_error",
    status: 503,
    message: "Codex backend unavailable.",
    preflight,
    availableModels: baseModels,
  });

  assert.equal(failure.payload.selection.requestedModelId, "codex:gpt-5.4-mini");
  assert.equal(failure.payload.selection.selectionSource, "user_explicit");
  assert.equal(failure.payload.proposedSubscriptionFallbacks[0]?.toModelId, "MiniMax-M3");
  assert.equal(failure.payload.requiresExplicitConfirmation, true);
});

test("MiniMax subscription failure proposes Codex subscription, but does not execute it", () => {
  const preflight = preflightChatModel({
    modelId: "MiniMax-M3",
    reasoningOption: "low",
    thinkingMode: "provider_default",
    selectionSource: "project_default",
    availableModels: baseModels,
    resolveModel: resolver(baseModels),
    getModelMeta: metaLookup(baseModels),
  });
  assert.equal(preflight.ok, true);
  if (!preflight.ok) return;

  const failure = chatFailureFromProviderIssue({
    kind: "provider_configuration_error",
    status: 503,
    message: "MiniMax quota exhausted.",
    preflight,
    availableModels: baseModels,
  });

  assert.equal(failure.payload.selection.requestedModelId, "MiniMax-M3");
  assert.equal(failure.payload.selection.selectionSource, "project_default");
  assert.equal(failure.payload.proposedSubscriptionFallbacks[0]?.toModelId, "codex:gpt-5.4-mini");
  assert.equal(failure.payload.requiresExplicitConfirmation, true);
});

test("OpenAI API / OpenRouter-like API billing are never selected as fallback", () => {
  const proposals = subscriptionFallbackProposals({
    requestedModelId: "MiniMax-M3",
    requestedProviderId: "minimax",
    requestedBillingSource: "subscription",
    selectionSource: "project_default",
    reason: "MiniMax unavailable.",
    availableModels: [
      option({ providerId: "openai", modelId: "gpt-5.4-mini", capability: effortLevels }),
      option({ providerId: "codex", modelId: "codex:gpt-5.4-mini" }),
      {
        ...option({ providerId: "openai", modelId: "openrouter:some-api-model" }),
        providerLabel: "OpenRouter API billing",
        modelLabel: "OpenRouter API model",
        billingLabel: "OpenAI API billing",
        accessPath: "openai_api",
      },
    ],
  });

  assert.deepEqual(
    proposals.map((p) => p.toProviderId),
    ["codex"],
  );
});

test("accepted discovered MiniMax subscription model executes exact selection when sync resolver lacks it", () => {
  const discoveredMiniMax = option({
    providerId: "minimax",
    modelId: "MiniMax-M2.1-highspeed",
    capability: { kind: "thinking_budget", control: "unknown" },
  });
  const knownModels = baseModels;
  const res = preflightChatModel({
    modelId: "MiniMax-M2.1-highspeed",
    reasoningOption: "low",
    thinkingMode: "provider_default",
    selectionSource: "user_accepted",
    availableModels: [discoveredMiniMax, ...knownModels],
    resolveModel: resolver(knownModels),
    getModelMeta: metaLookup(knownModels),
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.metadata.modelId, "MiniMax-M2.1-highspeed");
    assert.equal(res.metadata.providerId, "minimax");
    assert.equal(res.metadata.selectionSource, "user_accepted");
    assert.equal(res.metadata.billingSource, "subscription");
    assert.deepEqual(res.reasoningCapability, discoveredMiniMax.reasoningCapability);
  }
});

test("accepted subscription proposal is represented as explicit user-accepted selection, not fallback", () => {
  const res = preflightChatModel({
    modelId: "MiniMax-M3",
    reasoningOption: "low",
    thinkingMode: "provider_default",
    selectionSource: "user_accepted",
    availableModels: baseModels,
    resolveModel: resolver(baseModels),
    getModelMeta: metaLookup(baseModels),
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.metadata.modelId, "MiniMax-M3");
    assert.equal(res.metadata.selectionSource, "user_accepted");
    assert.equal(res.metadata.billingSource, "subscription");
  }
});

test("returned error payload contains enough data for safe UI proposal rendering", () => {
  const models = [
    option({ providerId: "codex", modelId: "codex:gpt-5.4-mini" }),
    option({ providerId: "minimax", modelId: "MiniMax-M3" }),
  ];
  const preflight = preflightChatModel({
    modelId: "codex:gpt-5.4-mini",
    reasoningOption: "low",
    thinkingMode: "provider_default",
    selectionSource: "user_explicit",
    availableModels: models,
    resolveModel: resolver(models),
    getModelMeta: metaLookup(models),
  });
  assert.equal(preflight.ok, true);
  if (!preflight.ok) return;

  const failure = chatFailureFromProviderIssue({
    kind: "provider_configuration_error",
    status: 503,
    message: "Codex unavailable.",
    preflight,
    availableModels: models,
  });
  const proposal = failure.payload.proposedSubscriptionFallbacks[0];

  assert.equal(failure.payload.policy, "NO_API_BILLING_FALLBACK");
  assert.equal(failure.payload.selection.requestedProviderId, "codex");
  assert.equal(failure.payload.selection.billingSource, "subscription");
  assert.equal(proposal?.toModelId, "MiniMax-M3");
  assert.equal(proposal?.toProviderId, "minimax");
  assert.equal(proposal?.billingSource, "subscription");
  assert.ok(proposal?.displayLabel);
  assert.ok(proposal?.reason);
});
