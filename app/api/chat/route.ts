import { openai } from "@ai-sdk/openai";
import { frontendTools } from "@assistant-ui/react-ai-sdk";
import {
  type JSONSchema7,
  streamText,
  convertToModelMessages,
  generateText,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { fakeAssistantText, isFakeLlmEnabled } from "@/lib/router/fake-llm";
import { isDbConfigured } from "@/lib/db";
import { extractLatestUserMessage, uiMessageText } from "@/lib/assistant-ui/thread-messages";
import { createMessage, getThread } from "@/lib/repo/threads";
import { getProject } from "@/lib/repo/projects";
import { getModelMeta, resolveModel, getDefaultRouterModelId } from "@/lib/providers";
import { getEffectiveModelsResponse } from "@/lib/providers/registry";
import { getBillingSourceForProvider } from "@/lib/providers/billing-source";
import { assertModelExecutionAllowed, ProviderAccessError } from "@/lib/providers/access-control";
import {
  enforceNoApiBillingFallback,
  type ProposedSubscriptionFallback,
} from "@/lib/policy/no-api-billing-fallback";
import type { BillingSource, ModelMeta, ProviderId, SelectionSource } from "@/lib/providers/types";
import {
  getRuntimeModel,
  getRuntimeProviderOptions,
  ProviderConfigurationError,
  type ThinkingMode,
} from "@/lib/providers/runtime";
import { type RouterSettings } from "@/lib/router/schema";
import { getEffectiveRouterSettings } from "@/lib/router/settings-store";
import { runRouterGraph, type RouterGraphOutput } from "@/lib/router/graph";
import {
  buildRouterRecentTurns,
  computeRouterRecentChars,
  latestUserText,
  poolKeyHash,
} from "@/lib/router/ab-session";
import { attachSideBResult, createAbSession, recordSideBOutput } from "@/lib/repo/router-ab";
import type { AbTaskType } from "@/lib/repo/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validThreadId(threadId: unknown): string | null {
  return typeof threadId === "string" && UUID_RE.test(threadId) ? threadId : null;
}

function parseReasoningOption(value: unknown): string {
  // The chat composer may send a provider-native value (e.g. "low",
  // "medium", "xhigh", "none", "minimal"). We do NOT narrow to a
  // fixed enum — the runtime adapter forwards the value verbatim.
  // Malformed values are rejected below rather than silently falling
  // back to a default.
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return "low";
}

function parseThinkingMode(value: unknown): ThinkingMode {
  if (value == null || value === "") return "provider_default";
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return "__invalid__";
}

function validSelectionSource(value: unknown): SelectionSource {
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

async function persistUserMessage(threadId: string, messages: UIMessage[], modelId: string | null) {
  const message = extractLatestUserMessage(messages);
  if (!message) return null;
  return await createMessage({
    threadId,
    role: "user",
    content: uiMessageText(message),
    parts: message.parts,
    modelId,
  });
}

async function persistAssistantMessage(threadId: string, message: UIMessage, modelId: string) {
  return await createMessage({
    threadId,
    role: "assistant",
    content: uiMessageText(message),
    parts: message.parts,
    modelId,
  });
}

/**
 * Router A/B data part shapes emitted by this route.
 *
 * The panel (`components/assistant-ui/router-ab-panel.tsx`) consumes both
 * data parts via the `useAssistantDataUI` helper from `@assistant-ui/react`.
 * Other data part names from the rest of the app are unaffected — we add
 * new names without touching existing UI.
 */
export type RouterAbDataParts = {
  "router-ab": {
    sessionId: string;
    sideA: { modelId: string; reasoningLevel: string };
    sideB: { modelId: string; reasoningLevel: string } | null;
    recommendation: RouterAbRecommendationDto | null;
    usedFallback: boolean;
    fallbackReason: string | null;
    skipReason: string | null;
    shortReason: string | null;
    taskType: AbTaskType | null;
    confidence: number | null;
    diagnostics: {
      routerModelId: string;
      mainModelId: string;
      routerAbEnabled: boolean;
    };
  };
  "router-ab-side-b": {
    sessionId: string;
    sideBText: string;
    sideBLatencyMs: number;
  };
};

/**
 * Canonical reasoning / thinking capability for the resolved chat model.
 * Surfaced to the panel so it can render the right reasoning UI even
 * after reload. When the model is unknown to the registry, falls back
 * to `{ kind: "unknown", control: "unknown" }`.
 */
export type ResolvedReasoningCapability =
  | {
      kind: "effort_levels";
      control: "supported" | "model_dependent" | "unknown";
      levels: ReadonlyArray<string>;
    }
  | {
      kind: "thinking_budget";
      control: "supported" | "model_dependent" | "unknown";
      supportsEnabled?: boolean;
      supportsTokenBudget?: boolean;
      supportsExclude?: boolean;
      defaultMode?: "provider_default" | "enabled" | "disabled";
      description?: string;
    }
  | { kind: "none"; control: "unsupported"; reason?: string }
  | { kind: "unknown"; control: "unknown"; reason?: string };

type RouterAbUiMessage = UIMessage<unknown, RouterAbDataParts>;

type RouterAbRecommendationDto = {
  recommendedModel: string;
  recommendedReasoningLevel: string;
  confidence: number;
  taskType: AbTaskType;
  shortReason: string;
};

function routerAbRecommendationFromOutput(
  output: RouterGraphOutput | null,
): RouterAbRecommendationDto | null {
  const r = output?.recommendation ?? null;
  if (!r) return null;
  return {
    recommendedModel: r.recommendedModel,
    recommendedReasoningLevel: r.recommendedReasoningLevel,
    confidence: r.confidence,
    taskType: r.taskType,
    shortReason: r.shortReason,
  };
}

type ChatLoudFailureKind =
  | "model_unavailable"
  | "provider_access_blocked"
  | "provider_configuration_error"
  | "reasoning_mode_unsupported"
  | "thinking_mode_unsupported"
  | "unknown_model"
  | "default_model_unavailable";

type ChatLoudFailurePayload = {
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

async function subscriptionFallbackProposals(input: {
  requestedModelId: string;
  requestedProviderId: ProviderId;
  requestedBillingSource: BillingSource;
  selectionSource: SelectionSource;
  reason: string;
}): Promise<ReadonlyArray<ProposedSubscriptionFallback>> {
  const effective = await getEffectiveModelsResponse();
  const candidates: ModelMeta[] = effective.models
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
  const policy = enforceNoApiBillingFallback({
    requested: {
      modelId: input.requestedModelId,
      providerId: input.requestedProviderId,
      billingSource: input.requestedBillingSource,
      selectionSource: input.selectionSource,
    },
    kind: "model_unavailable",
    reason: input.reason,
    candidates,
    registry: effective.models.map((m) => ({ modelId: m.modelId, displayLabel: m.modelLabel })),
  });
  return policy.proposals;
}

async function chatLoudFailure(input: {
  kind: ChatLoudFailureKind;
  status?: number;
  message: string;
  reason?: string;
  requestedModelId: string | null;
  requestedProviderId: ProviderId | null;
  selectionSource: SelectionSource;
  billingSource: BillingSource | null;
}): Promise<Response> {
  const reason = input.reason ?? input.message;
  const proposedSubscriptionFallbacks =
    input.requestedModelId && input.requestedProviderId && input.billingSource
      ? await subscriptionFallbackProposals({
          requestedModelId: input.requestedModelId,
          requestedProviderId: input.requestedProviderId,
          requestedBillingSource: input.billingSource,
          selectionSource: input.selectionSource,
          reason,
        })
      : [];
  return Response.json(
    {
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
    } satisfies ChatLoudFailurePayload,
    { status: input.status ?? 409 },
  );
}

export async function POST(req: Request) {
  const {
    messages,
    system,
    tools,
    modelId,
    threadId: rawThreadId,
    reasoningOption: rawReasoningOption,
    thinkingMode: rawThinkingMode,
    routerAb: routerAbOn,
    selectionSource: rawSelectionSource,
  }: {
    messages: UIMessage[];
    system?: string;
    tools?: Record<string, { description?: string; parameters: JSONSchema7 }>;
    modelId?: string;
    threadId?: string;
    /**
     * Provider-native reasoning-effort value (e.g. `"low"`,
     * `"medium"`, `"xhigh"`, `"none"`, `"minimal"`). The runtime
     * adapter validates the value against the model's
     * `reasoningCapability.options` before forwarding it to the
     * provider. Legacy callers may still send `reasoningLevel`; we
     * accept both for backwards compatibility during the migration.
     */
    reasoningOption?: string;
    /** @deprecated Use `reasoningOption` (provider-native value). */
    reasoningLevel?: string;
    /**
     * Thinking-mode pick for thinking-budget models (MiniMax M3).
     * Distinct from `reasoningOption`. The runtime adapter translates
     * this into the provider-native reasoning payload when the
     * capability says it's safe to do so.
     */
    thinkingMode?: string;
    routerAb?: boolean;
    selectionSource?: SelectionSource;
  } = await req.json();

  const selectionSource = validSelectionSource(rawSelectionSource);
  const effectiveModels = await getEffectiveModelsResponse();

  if (!modelId) {
    return chatLoudFailure({
      kind: "default_model_unavailable",
      status: 409,
      message:
        "Your default model is hidden or unavailable. Re-enable it in Settings or choose another model.",
      requestedModelId: null,
      requestedProviderId: null,
      selectionSource,
      billingSource: null,
    });
  }

  const selectedEffective = effectiveModels.models.find((m) => m.modelId === modelId) ?? null;
  if (!selectedEffective) {
    return chatLoudFailure({
      kind: "model_unavailable",
      status: 409,
      message:
        "Your default model is hidden or unavailable. Re-enable it in Settings or choose another model.",
      requestedModelId: modelId,
      requestedProviderId: null,
      selectionSource,
      billingSource: null,
    });
  }

  const requestedProviderId = selectedEffective.providerId;
  const requestedBillingSource = getBillingSourceForProvider(
    selectedEffective.providerId,
    selectedEffective.modelId,
  );

  if (!selectedEffective.enabled) {
    return chatLoudFailure({
      kind: "model_unavailable",
      status: 409,
      message:
        selectedEffective.reason ??
        "Your default model is hidden or unavailable. Re-enable it in Settings or choose another model.",
      requestedModelId: selectedEffective.modelId,
      requestedProviderId,
      selectionSource,
      billingSource: requestedBillingSource,
    });
  }

  const result = resolveModel(modelId);

  if (!result.ok) {
    const err = result.error;
    return chatLoudFailure({
      kind: err.kind === "provider_disabled" ? "provider_access_blocked" : "unknown_model",
      status: err.kind === "unknown_model" ? 400 : 503,
      message:
        err.kind === "no_models_available"
          ? "No models are available. Configure a provider in Settings."
          : err.kind === "provider_disabled"
            ? err.reason
            : "The selected model is hidden, unavailable, or not configured. Re-enable it in Settings or choose another model.",
      requestedModelId: modelId,
      requestedProviderId,
      selectionSource,
      billingSource: requestedBillingSource,
    });
  }

  if (
    result.resolved.providerId !== requestedProviderId ||
    result.resolved.modelId !== selectedEffective.modelId ||
    result.resolved.billingSource !== requestedBillingSource
  ) {
    return chatLoudFailure({
      kind: "model_unavailable",
      status: 409,
      message:
        "Selected model resolution changed before execution. Control Room will not auto-substitute.",
      requestedModelId: selectedEffective.modelId,
      requestedProviderId,
      selectionSource,
      billingSource: requestedBillingSource,
    });
  }

  const reasoningOption = parseReasoningOption(rawReasoningOption);
  const thinkingMode = parseThinkingMode(rawThinkingMode);

  // Capability lookup for the resolved model. OpenAI static alias map
  // and Codex / MiniMax catalog all carry a `reasoningCapability`
  // now; if the registry has no metadata for this id (e.g. opted-in
  // unconfigured OpenAI model), we pass through to the runtime with
  // an `unknown` capability — the runtime will omit reasoning
  // provider options rather than fake one.
  const meta = getModelMeta(result.resolved.modelId);
  const reasoningCapability =
    meta?.reasoningCapability ?? ({ kind: "unknown", control: "unknown" } as const);

  if (thinkingMode === "__invalid__") {
    return chatLoudFailure({
      kind: "thinking_mode_unsupported",
      status: 400,
      message: "Invalid thinking mode. Control Room will not silently use a provider default.",
      requestedModelId: result.resolved.modelId,
      requestedProviderId: result.resolved.providerId,
      selectionSource,
      billingSource: result.resolved.billingSource,
    });
  }

  if (
    reasoningCapability.kind === "thinking_budget" &&
    reasoningCapability.control === "supported" &&
    thinkingMode !== "provider_default" &&
    reasoningCapability.modes?.length &&
    !reasoningCapability.modes.some((m) => m.value === thinkingMode)
  ) {
    return chatLoudFailure({
      kind: "thinking_mode_unsupported",
      status: 400,
      message: `Thinking mode ${thinkingMode} is not supported by ${result.resolved.modelId}.`,
      requestedModelId: result.resolved.modelId,
      requestedProviderId: result.resolved.providerId,
      selectionSource,
      billingSource: result.resolved.billingSource,
    });
  }

  try {
    await assertModelExecutionAllowed({
      providerId: result.resolved.providerId,
      modelId: result.resolved.modelId,
      surface: "manual_chat",
      reasoningLevel: reasoningOption,
    });
  } catch (err) {
    if (err instanceof ProviderAccessError) {
      return chatLoudFailure({
        kind:
          err.message.includes("Reasoning level") || err.message.includes("reasoning controls")
            ? "reasoning_mode_unsupported"
            : "provider_access_blocked",
        status: err.status,
        message: err.message,
        requestedModelId: result.resolved.modelId,
        requestedProviderId: result.resolved.providerId,
        selectionSource,
        billingSource: result.resolved.billingSource,
      });
    }
    throw err;
  }

  const routerAbSupported = result.resolved.providerId === "openai";

  let sideAModel;
  let sideAProviderOptions;
  try {
    sideAModel = getRuntimeModel(result.resolved);
    sideAProviderOptions = getRuntimeProviderOptions({
      resolved: result.resolved,
      capability: reasoningCapability,
      reasoningOption,
      thinkingMode,
    });
  } catch (err: unknown) {
    if (err instanceof ProviderConfigurationError) {
      return chatLoudFailure({
        kind: "provider_configuration_error",
        status: 503,
        message: err.message,
        requestedModelId: result.resolved.modelId,
        requestedProviderId: result.resolved.providerId,
        selectionSource,
        billingSource: result.resolved.billingSource,
      });
    }
    throw err;
  }

  // Only real chat messages go into model context. Ratings, notes, feedback,
  // traces, debug metadata, and routing metadata are not loaded here.
  const modelMessages = await convertToModelMessages(messages);
  const threadId = validThreadId(rawThreadId);

  let projectSystem: string | undefined;
  if (threadId && isDbConfigured()) {
    const thread = await getThread(threadId);
    if (thread?.projectId) {
      const project = await getProject(thread.projectId);
      if (project) {
        projectSystem = [
          "Selected project metadata (do not read files or modify this repository unless a future tool explicitly provides that capability):",
          `- Project name: ${project.name}`,
          `- Local path: ${project.localPath}`,
          `- Git remote URL: ${project.gitRemoteUrl ?? "unavailable"}`,
          `- Current branch: ${project.gitBranch ?? "unavailable"}`,
        ].join("\n");
      }
    }
  }
  const effectiveSystem = [system, projectSystem].filter(Boolean).join("\n\n") || undefined;

  // Persist the user message synchronously so we have a stable
  // `user_message_id` to attach to the A/B session row. If the DB is
  // unconfigured or write fails, we fall through with no id (the A/B
  // session row is still inserted with `user_message_id=null`).
  let userMessageId: string | null = null;
  if (threadId && isDbConfigured()) {
    try {
      const persisted = await persistUserMessage(threadId, messages, result.resolved.modelId);
      userMessageId = persisted?.id ?? null;
    } catch (err: unknown) {
      console.error(
        "[api/chat] failed to persist user message:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Run the router (cheap GPT-5.4 Mini structured-output call) so Side B
  // has a model + reasoning level picked before Side A starts streaming.
  // If the user has the A/B toggle off, or settings.abEnabled is false, or
  // the router throws, we still answer Side A and skip Side B.
  const routerAbEnabled = Boolean(routerAbOn) && routerAbSupported;
  // Read the effective settings from the DB-backed singleton (or env
  // fallback when the DB is not configured). The Settings UI at
  // /settings/router writes to that singleton.
  const settings: RouterSettings = await getEffectiveRouterSettings();
  const latestText = latestUserText(messages);
  const recentTurns = buildRouterRecentTurns(messages);
  const recentChars = computeRouterRecentChars(latestText, recentTurns);

  const routerModelIdUsed = settings.routerModelId || getDefaultRouterModelId();
  console.info("[api/chat] router diagnostics", {
    routerAbEnabled,
    settingsAbEnabled: settings.abEnabled,
    routerModelId: routerModelIdUsed,
    mainModelId: result.resolved.modelId,
  });

  let routerOutput: RouterGraphOutput | null = null;
  if (routerAbEnabled && settings.abEnabled) {
    try {
      await assertModelExecutionAllowed({
        providerId: "openai",
        modelId: routerModelIdUsed,
        surface: "router",
        reasoningLevel: "low",
      });
      routerOutput = await runRouterGraph({
        latestUserText: latestText,
        recentTurns,
        sideA: { modelId: result.resolved.modelId, reasoningLevel: reasoningOption },
        recentChars,
        settingsOverride: settings,
      });
    } catch (err: unknown) {
      console.error("[api/chat] router graph failed:", err instanceof Error ? err.message : err);
      routerOutput = null;
    }
  }

  // Persist the A/B session row up-front. Side B fields are best-effort
  // here; the second pass (when Side B resolves or is skipped) updates
  // them via `attachSideBResult`.
  let sessionId: string | null = null;
  if (routerAbEnabled && settings.abEnabled && threadId) {
    try {
      const hash = await poolKeyHash(
        routerOutput?.sideB
          ? [
              {
                modelId: routerOutput.sideB.modelId,
                reasoningLevel: routerOutput.sideB.reasoningLevel,
              },
            ]
          : [],
      );
      const session = await createAbSession({
        threadId,
        userMessageId,
        sideAModelId: result.resolved.modelId,
        sideAReasoningLevel: reasoningOption,
        userPromptText: latestText,
        recentChars,
        routerModelId: routerModelIdUsed,
        sideBModelId: routerOutput?.sideB?.modelId ?? null,
        sideBReasoningLevel: routerOutput?.sideB?.reasoningLevel ?? null,
        taskType: routerOutput?.recommendation?.taskType ?? null,
        confidence: routerOutput?.recommendation?.confidence ?? null,
        shortReason: routerOutput?.recommendation?.shortReason ?? null,
        usedFallback: routerOutput?.usedFallback ?? false,
        fallbackReason: routerOutput?.fallbackReason ?? null,
        skipReason: routerOutput?.skipReason ?? null,
        costEstimateUsd: routerOutput?.estimatedCostUsd ?? null,
        poolKeyHash: hash,
      });
      sessionId = session.id;
    } catch (err: unknown) {
      console.error(
        "[api/chat] failed to create ab_session:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Build the streaming Side A as before.
  //
  // Fake-LLM mode: when CONTROL_ROOM_FAKE_LLM=1, we route through a
  // deterministic stub stream so the full pipeline (router → Side A → Side
  // B → persistence → panel → feedback) runs end-to-end without burning
  // tokens. The stub emits a short assistant paragraph as one streamed
  // delta so the client-side UI still sees a normal text-delta stream.
  const sideAStream = isFakeLlmEnabled()
    ? fakeStreamText({
        modelId: result.resolved.modelId,
        reasoningLevel: reasoningOption,
        userPrompt: latestText,
        side: "A",
      })
    : streamText({
        model: sideAModel,
        messages: modelMessages,
        system: effectiveSystem,
        tools: {
          ...frontendTools(tools ?? {}),
        },
        ...(sideAProviderOptions ? { providerOptions: sideAProviderOptions } : {}),
      });

  const stream = createUIMessageStream<RouterAbUiMessage>({
    originalMessages: messages as RouterAbUiMessage[],
    onError: () =>
      result.resolved.providerId === "minimax"
        ? "MiniMax provider error. Check MINIMAX_API_KEY, MINIMAX_BASE_URL, and MINIMAX_DEFAULT_MODEL."
        : "An error occurred.",
    execute: async ({ writer }) => {
      // Emit the initial router decision as soon as we have it, BEFORE
      // Side A starts streaming. This lets the panel render the
      // "Router says:" line and the "Side B generating…" placeholder
      // while Side A is still streaming.
      //
      // When the request did not include a `threadId` we still emit the
      // data part (with a synthetic session id) so the panel renders for
      // ad-hoc local chats. The session row only exists when the request
      // had a real thread id; reload re-hydration in that case returns
      // 404 and the panel stays at its live-render state.
      if (sessionId || routerAbEnabled) {
        writer.write({
          type: "data-router-ab",
          data: {
            sessionId: sessionId ?? "ad-hoc",
            sideA: { modelId: result.resolved.modelId, reasoningLevel: reasoningOption },
            sideB: routerOutput?.sideB ?? null,
            recommendation: routerAbRecommendationFromOutput(routerOutput),
            usedFallback: routerOutput?.usedFallback ?? false,
            fallbackReason: routerOutput?.fallbackReason ?? null,
            skipReason: routerOutput?.skipReason ?? null,
            shortReason: routerOutput?.recommendation?.shortReason ?? null,
            taskType: routerOutput?.recommendation?.taskType ?? null,
            confidence: routerOutput?.recommendation?.confidence ?? null,
            diagnostics: {
              routerModelId: routerModelIdUsed,
              mainModelId: result.resolved.modelId,
              routerAbEnabled,
            },
          },
        });
      }

      // Merge Side A's UI message stream into ours.
      const sideAUiStream = sideAStream.toUIMessageStream({
        originalMessages: messages as RouterAbUiMessage[],
        sendReasoning: false,
        sendSources: false,
      });
      writer.merge(sideAUiStream as never);

      // Kick off Side B non-streaming in parallel. We await its completion
      // here so the panel re-hydrates the full text via the second data
      // part even if the user never reloads.
      const sideBPicked = routerOutput?.sideB ?? null;
      if (sideBPicked && !routerOutput?.skipReason) {
        try {
          const sideBStart = Date.now();
          let sideBText: string;
          if (isFakeLlmEnabled()) {
            sideBText = (
              await fakeGenerateTextResult({
                modelId: sideBPicked.modelId,
                reasoningLevel: sideBPicked.reasoningLevel,
                userPrompt: latestText,
                side: "B",
              })
            ).text;
          } else {
            const sideBResult = await generateText({
              model: openai(sideBPicked.modelId),
              messages: modelMessages,
              system: effectiveSystem,
              providerOptions: {
                openai: { reasoningEffort: sideBPicked.reasoningLevel },
              },
            });
            sideBText = sideBResult.text;
          }
          const sideBLatencyMs = Date.now() - sideBStart;
          // `sideBText` is now bound from either the fake or the real path.
          // Persist Side B text + latency immediately so the panel can
          // re-hydrate on page reload. The `assistant_message_id` link is
          // backfilled in `onFinish` below. Skip persistence for ad-hoc
          // sessions (no real thread id) since they have no row to update.
          if (sessionId) {
            void recordSideBOutput({
              abSessionId: sessionId,
              sideBText,
              sideBLatencyMs,
            }).catch((err: unknown) => {
              console.error(
                "[api/chat] failed to persist side_b_text:",
                err instanceof Error ? err.message : err,
              );
            });
          }
          writer.write({
            type: "data-router-ab-side-b",
            data: { sessionId: sessionId ?? "ad-hoc", sideBText, sideBLatencyMs },
          });
        } catch (err: unknown) {
          console.error("[api/chat] Side B failed:", err instanceof Error ? err.message : err);
          // Persist skip-reason-style failure on the session row.
          if (sessionId) {
            void attachSideBResult({
              abSessionId: sessionId,
              sideBModelId: sideBPicked.modelId,
              sideBReasoningLevel: sideBPicked.reasoningLevel,
              taskType: routerOutput?.recommendation?.taskType ?? null,
              confidence: routerOutput?.recommendation?.confidence ?? null,
              shortReason: routerOutput?.recommendation?.shortReason ?? null,
              usedFallback: routerOutput?.usedFallback ?? false,
              fallbackReason: `side_b_call_failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
              skipReason: "Side B generation failed",
              costEstimateUsd: routerOutput?.estimatedCostUsd ?? null,
            }).catch((err2: unknown) => {
              const msg2 = err2 instanceof Error ? err2.message : String(err2);
              console.error("[api/chat] failed to record Side B failure:", msg2);
            });
          }
        }
      } else if (sessionId && routerOutput?.skipReason) {
        // No Side B. The session row already records the skip reason; we
        // emit nothing else here. The panel uses `skipReason` to render
        // the "skipped" notice.
      }
    },
    onFinish: async ({ responseMessage, isAborted }) => {
      if (!threadId || !isDbConfigured()) return;
      try {
        const persistedAssistant = await persistAssistantMessage(
          threadId,
          responseMessage,
          result.resolved.modelId,
        );
        if (sessionId) {
          // Backfill assistant_message_id on the session row so the panel
          // can be re-hydrated by message id after a reload.
          await attachSideBResult({
            abSessionId: sessionId,
            assistantMessageId: persistedAssistant.id,
            sideBModelId: routerOutput?.sideB?.modelId ?? null,
            sideBReasoningLevel: routerOutput?.sideB?.reasoningLevel ?? null,
            taskType: routerOutput?.recommendation?.taskType ?? null,
            confidence: routerOutput?.recommendation?.confidence ?? null,
            shortReason: routerOutput?.recommendation?.shortReason ?? null,
            usedFallback: routerOutput?.usedFallback ?? false,
            fallbackReason: routerOutput?.fallbackReason ?? null,
            skipReason: routerOutput?.skipReason ?? null,
            costEstimateUsd: routerOutput?.estimatedCostUsd ?? null,
          });
        }
      } catch (err: unknown) {
        console.error(
          "[api/chat] failed to persist assistant message:",
          err instanceof Error ? err.message : err,
        );
      }
      void isAborted;
    },
  });

  return createUIMessageStreamResponse({
    stream: stream as unknown as ReadableStream<UIMessageChunk>,
    headers: { "Cache-Control": "no-store" },
  });
}

// ---------------------------------------------------------------------------
// Fake-LLM stubs (gated by CONTROL_ROOM_FAKE_LLM=1)
// ---------------------------------------------------------------------------
//
// These helpers produce the same wire shape as the real AI SDK calls so
// the rest of the chat route is unchanged when the flag is on. Side A
// goes through `fakeStreamText` which yields a normal UI message stream
// with one text delta + finish. Side B goes through `fakeGenerateTextResult`
// which returns the same shape as `generateText`.

function fakeStreamText(args: {
  modelId: string;
  reasoningLevel: string;
  userPrompt: string;
  side: "A" | "B";
}): {
  toUIMessageStream: (opts: { originalMessages: UIMessage[] }) => ReadableStream<UIMessageChunk>;
} {
  const text = fakeAssistantText({
    side: args.side,
    modelId: args.modelId,
    reasoningLevel: args.reasoningLevel,
    userPrompt: args.userPrompt,
  });
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.enqueue({ type: "text-start", id: "t1" } as UIMessageChunk);
      controller.enqueue({ type: "text-delta", id: "t1", delta: text } as UIMessageChunk);
      controller.enqueue({ type: "text-end", id: "t1" } as UIMessageChunk);
      controller.enqueue({ type: "finish", finishReason: "stop" } as UIMessageChunk);
      controller.close();
    },
  });
  return {
    toUIMessageStream: () => stream,
  };
}

async function fakeGenerateTextResult(args: {
  modelId: string;
  reasoningLevel: string;
  userPrompt: string;
  side: "A" | "B";
}): Promise<{ text: string }> {
  return {
    text: fakeAssistantText({
      side: args.side,
      modelId: args.modelId,
      reasoningLevel: args.reasoningLevel,
      userPrompt: args.userPrompt,
    }),
  };
}
