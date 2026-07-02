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
import {
  filterModelContextMessages,
  formatRoutingDecisionMarkdown,
  routingDecisionAuditId,
  routingDecisionPart,
  routingDecisionTextPart,
  isRoutingDecisionPart,
  type RoutingDecisionPayload,
} from "@/lib/assistant-ui/routing-decision";
import { createMessage, getThread, listMessages } from "@/lib/repo/threads";
import { getProject } from "@/lib/repo/projects";
import { getModelMeta, resolveModel, getDefaultRouterModelId } from "@/lib/providers";
import { getEffectiveModelsResponse } from "@/lib/providers/registry";
import { assertModelExecutionAllowed, ProviderAccessError } from "@/lib/providers/access-control";
import { chatFailureFromProviderIssue, preflightChatModel } from "@/lib/policy/chat-send-preflight";
import type { SelectionSource } from "@/lib/providers/types";
import {
  getRuntimeModel,
  getRuntimeProviderOptions,
  ProviderConfigurationError,
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
import {
  attachSideBResult,
  createAbSession,
  estimateSideBLatency,
  recordSideBOutput,
} from "@/lib/repo/router-ab";
import type { AbTaskType } from "@/lib/repo/types";
import {
  classifyTokens,
  estimateExecution,
  estimateTokens,
  latencyOutcome,
  promptHash,
} from "@/lib/router/telemetry";
import { completeExecutionRun, createExecutionRun } from "@/lib/repo/router-telemetry";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validThreadId(threadId: unknown): string | null {
  return typeof threadId === "string" && UUID_RE.test(threadId) ? threadId : null;
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

function messageHasRoutingAuditId(message: { parts: unknown }, auditId: string): boolean {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts.some(
    (part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "data-routing-decision" &&
      (part as { data?: { auditId?: unknown } }).data?.auditId === auditId,
  );
}

async function persistRoutingDecisionMessage(input: {
  threadId: string;
  payload: RoutingDecisionPayload;
  modelId?: string | null;
}): Promise<{ auditId: string; parts: unknown[] } | null> {
  if (input.payload.messageType !== "routing_decision" || input.payload.includeInModelContext !== false) return null;
  const existing = await listMessages(input.threadId);
  if (existing.some((message) => messageHasRoutingAuditId(message, input.payload.auditId))) {
    // Return existing parts for deduplication in the stream response
    const existingMessage = existing.find((message) => messageHasRoutingAuditId(message, input.payload.auditId));
    const existingParts = Array.isArray(existingMessage?.parts) ? existingMessage.parts : [];
    return existingMessage ? { auditId: input.payload.auditId, parts: existingParts } : null;
  }
  const parts = [routingDecisionTextPart(input.payload), routingDecisionPart(input.payload)];
  await createMessage({
    threadId: input.threadId,
    role: "assistant",
    content: formatRoutingDecisionMarkdown(input.payload),
    parts,
    modelId: input.modelId ?? null,
  });
  return { auditId: input.payload.auditId, parts };
}

async function persistManualRoutingDecision(input: {
  threadId: string;
  contextMessages: UIMessage[];
  modelId: string;
  reasoningOrThinking: string;
  selectionSource: SelectionSource;
}) {
  if (input.selectionSource === "user_accepted") return;
  const latest = extractLatestUserMessage(input.contextMessages);
  const prompt = latest ? uiMessageText(latest).trim() : "";
  if (!prompt) return;
  const payload: RoutingDecisionPayload = {
    messageType: "routing_decision",
    includeInModelContext: false,
    auditId: routingDecisionAuditId({
      threadId: input.threadId,
      prompt,
      route: "normal_chat",
      executionModel: input.modelId,
    }),
    route: "normal_chat",
    selectionSource: "manual_current_selection",
    harness: null,
    routerEngine: null,
    recommenderEngine: null,
    recommenderReasoningLevel: null,
    executionModel: input.modelId,
    executionReasoningLevel: input.reasoningOrThinking,
    fallback: null,
    whyRoute: "Direct normal chat send using the current manual selection.",
    whyModel:
      "Recommender was not used; Control Room used the currently selected model and reasoning/thinking setting.",
    alternatives: [],
  };
  await persistRoutingDecisionMessage({ threadId: input.threadId, payload });
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
    expected_latency_ms: number;
    upper_latency_ms: number;
    estimate_quality: "likely" | "uncertain" | "rough";
    latency_policy: string;
    latency_basis: string;
    historical_sample_count: number;
    started_at: string;
    completed_at: string | null;
    actual_latency_ms: number | null;
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
    completed_at: string;
    actual_latency_ms: number;
  };
  "router-execution-estimate": {
    runId: string | null;
    model_id: string;
    model_name: string;
    reasoning_level: string | null;
    provider_path: string;
    selected_model_id: string;
    recommended_model_id: string | null;
    estimated_cost_usd: number | null;
    expected_execution_latency_ms: number;
    upper_execution_latency_ms: number;
    expected_input_tokens: number;
    expected_output_tokens: number;
    expected_total_tokens: number;
    estimate_quality: "likely" | "uncertain" | "rough";
    started_at: string;
  };
  "router-execution-outcome": {
    runId: string | null;
    actual_execution_latency_ms: number;
    actual_input_tokens: number;
    actual_output_tokens: number;
    actual_total_tokens: number;
    latency_deviation_ms: number;
    latency_deviation_pct: number | null;
    token_deviation_count: number;
    token_deviation_pct: number | null;
    latency_result: string;
    token_result: string;
    completed_at: string;
  };
  "routing-decision": {
    messageType: "routing_decision";
    includeInModelContext: false;
    auditId: string;
    route: "normal_chat" | "coding_task";
    selectionSource?: string | null;
    harness?: string | null;
    routerEngine?: string | null;
    recommenderEngine?: string | null;
    recommenderReasoningLevel?: string | null;
    executionModel?: string | null;
    executionReasoningLevel?: string | null;
    fallback?: {
      configured?: boolean;
      attempted?: boolean;
      used?: boolean;
      engine?: string | null;
      reason?: string | null;
    } | null;
    whyRoute?: string | null;
    whyHarness?: string | null;
    whyModel?: string | null;
    alternatives?: Array<Record<string, unknown>>;
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
    routingDecision,
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
    routingDecision?: RoutingDecisionPayload | null;
  } = await req.json();

  const effectiveModels = await getEffectiveModelsResponse();
  const preflight = preflightChatModel({
    modelId,
    reasoningOption: rawReasoningOption,
    thinkingMode: rawThinkingMode,
    selectionSource: rawSelectionSource,
    availableModels: effectiveModels.models,
    resolveModel,
    getModelMeta,
  });
  if (!preflight.ok) {
    return Response.json(preflight.payload, { status: preflight.status });
  }

  const result = { ok: true as const, resolved: preflight.resolved };
  const reasoningOption = preflight.reasoningOption;
  const thinkingMode = preflight.thinkingMode;
  const reasoningCapability = preflight.reasoningCapability;

  try {
    await assertModelExecutionAllowed({
      providerId: preflight.resolved.providerId,
      modelId: preflight.resolved.modelId,
      surface: "manual_chat",
      reasoningLevel: reasoningOption,
    });
  } catch (err) {
    if (err instanceof ProviderAccessError) {
      const failure = chatFailureFromProviderIssue({
        kind:
          err.message.includes("Reasoning level") || err.message.includes("reasoning controls")
            ? "reasoning_mode_unsupported"
            : "provider_access_blocked",
        status: err.status,
        message: err.message,
        preflight,
        availableModels: effectiveModels.models,
      });
      return Response.json(failure.payload, { status: failure.status });
    }
    throw err;
  }

  const routerAbSupported = preflight.resolved.providerId === "openai";

  let sideAModel;
  let sideAProviderOptions;
  try {
    sideAModel = getRuntimeModel(preflight.resolved);
    sideAProviderOptions = getRuntimeProviderOptions({
      resolved: preflight.resolved,
      capability: reasoningCapability,
      reasoningOption,
      thinkingMode,
    });
  } catch (err: unknown) {
    if (err instanceof ProviderConfigurationError) {
      const failure = chatFailureFromProviderIssue({
        kind: "provider_configuration_error",
        status: 503,
        message: err.message,
        preflight,
        availableModels: effectiveModels.models,
      });
      return Response.json(failure.payload, { status: failure.status });
    }
    throw err;
  }

  // Only real chat messages go into model context. Ratings, notes, feedback,
  // traces, debug metadata, and routing-decision audit bubbles are not loaded here.
  const contextMessages = filterModelContextMessages(messages);
  const modelMessages = await convertToModelMessages(contextMessages);
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
      const persisted = await persistUserMessage(threadId, contextMessages, result.resolved.modelId);
      userMessageId = persisted?.id ?? null;
    } catch (err: unknown) {
      console.error(
        "[api/chat] failed to persist user message:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Persist the UI-only routing decision after the user message, so reload
  // hydration orders it next to the turn instead of above prior turns or in a
  // separate bottom fallback list. It is never included in modelMessages above.
  // Store the routing decision parts so we can emit them in the stream AND
  // include them in the assistant message for correct display/hydration.
  let routingDecisionParts: unknown[] = [];
  if (threadId && isDbConfigured()) {
    try {
      if (routingDecision) {
        const persisted = await persistRoutingDecisionMessage({
          threadId,
          payload: routingDecision,
          modelId: routingDecision.recommenderEngine ?? routingDecision.routerEngine ?? null,
        });
        if (persisted) {
          routingDecisionParts = persisted.parts;
        }
      } else {
        await persistManualRoutingDecision({
          threadId,
          contextMessages,
          modelId: result.resolved.modelId,
          reasoningOrThinking:
            reasoningCapability.kind === "thinking_budget" ? thinkingMode : reasoningOption,
          selectionSource: preflight.selectionSource,
        });
      }
    } catch (err: unknown) {
      console.error(
        "[api/chat] failed to persist routing decision:",
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
  const latestText = latestUserText(contextMessages);
  const recentTurns = buildRouterRecentTurns(contextMessages);
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
  const latencyStartedAt = new Date().toISOString();
  let latencyEstimate: Awaited<ReturnType<typeof estimateSideBLatency>> = {
    expectedLatencyMs: recentChars > 12_000 ? 30_000 : recentChars > 4_000 ? 18_000 : 10_000,
    upperLatencyMs: recentChars > 12_000 ? 75_000 : recentChars > 4_000 ? 45_000 : 25_000,
    estimateQuality: "rough",
    latencyPolicy: "cold_start_fallback_v1",
    latencyBasis: "not_computed",
    historicalSampleCount: 0,
  };
  if (routerAbEnabled && settings.abEnabled && routerOutput?.sideB && !routerOutput.skipReason) {
    try {
      latencyEstimate = await estimateSideBLatency({
        sideBModelId: routerOutput.sideB.modelId,
        recentChars,
      });
    } catch (err: unknown) {
      console.error(
        "[api/chat] failed to estimate Side B latency:",
        err instanceof Error ? err.message : err,
      );
    }
  }
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

  const executionPromptTokens = estimateTokens(latestText);
  const executionContextTokens =
    estimateTokens(effectiveSystem ?? "") + Math.max(0, modelMessages.length - 1) * 64;
  const executionEstimate = await estimateExecution({
    selectedModelId: result.resolved.modelId,
    providerPath: result.resolved.providerId,
    promptTokenEstimate: executionPromptTokens,
    contextTokenEstimate: executionContextTokens,
    stepId: "normal_chat",
  });
  const executionModelName =
    getModelMeta(result.resolved.modelId)?.modelLabel ?? result.resolved.modelId;
  const recommendedModelId =
    rawSelectionSource === "user_accepted" ? result.resolved.modelId : null;
  const executionStartedAtMs = Date.now();
  const executionStartedAt = new Date(executionStartedAtMs).toISOString();
  const executionRunId = await createExecutionRun({
    stepId: "normal_chat",
    selectedModelId: result.resolved.modelId,
    providerPath: result.resolved.providerId,
    promptHash: promptHash(latestText),
    promptTokenEstimate: executionPromptTokens,
    contextTokenEstimate: executionContextTokens,
    expectedInputTokens: executionEstimate.expectedInputTokens,
    expectedOutputTokens: executionEstimate.expectedOutputTokens,
    expectedTotalTokens: executionEstimate.expectedTotalTokens,
    expectedExecutionLatencyMs: executionEstimate.expectedLatencyMs,
    upperExecutionLatencyMs: executionEstimate.upperLatencyMs,
    executionEstimateQuality: executionEstimate.estimateQuality,
    estimatedCostUsd: executionEstimate.estimatedCostUsd,
    startedAt: executionStartedAt,
  });

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
    originalMessages: contextMessages as RouterAbUiMessage[],
    onError: () =>
      result.resolved.providerId === "minimax"
        ? "MiniMax provider error. Check MINIMAX_API_KEY, MINIMAX_BASE_URL, and MINIMAX_DEFAULT_MODEL."
        : "An error occurred.",
    execute: async ({ writer }) => {
      // Emit routing decision data parts at the start of the stream so they're
      // visible in the assistant message alongside Side A's text. The
      // `routing-decision` data part is registered in `RouterAbDataParts` and
      // consumed by the UI via `AssistantMessage` which reads
      // `routingDecisionFromMessage(s.message)`.
      for (const part of routingDecisionParts) {
        if (isRoutingDecisionPart(part)) {
          writer.write({
            type: "data-routing-decision" as const,
            data: part.data,
          });
        }
      }

      writer.write({
        type: "data-router-execution-estimate",
        data: {
          runId: executionRunId,
          model_id: result.resolved.modelId,
          model_name: executionModelName,
          reasoning_level: reasoningOption ?? null,
          provider_path: result.resolved.providerId,
          selected_model_id: result.resolved.modelId,
          recommended_model_id: recommendedModelId,
          estimated_cost_usd: executionEstimate.estimatedCostUsd,
          expected_execution_latency_ms: executionEstimate.expectedLatencyMs,
          upper_execution_latency_ms: executionEstimate.upperLatencyMs,
          expected_input_tokens: executionEstimate.expectedInputTokens,
          expected_output_tokens: executionEstimate.expectedOutputTokens,
          expected_total_tokens: executionEstimate.expectedTotalTokens,
          estimate_quality: executionEstimate.estimateQuality,
          started_at: executionStartedAt,
        },
      });

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
            expected_latency_ms: latencyEstimate.expectedLatencyMs,
            upper_latency_ms: latencyEstimate.upperLatencyMs,
            estimate_quality: latencyEstimate.estimateQuality,
            latency_policy: latencyEstimate.latencyPolicy,
            latency_basis: latencyEstimate.latencyBasis,
            historical_sample_count: latencyEstimate.historicalSampleCount,
            started_at: latencyStartedAt,
            completed_at: null,
            actual_latency_ms: null,
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
        originalMessages: contextMessages as RouterAbUiMessage[],
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
          const sideBCompletedAt = new Date().toISOString();
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
            data: {
              sessionId: sessionId ?? "ad-hoc",
              sideBText,
              sideBLatencyMs,
              completed_at: sideBCompletedAt,
              actual_latency_ms: sideBLatencyMs,
            },
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
      const completedAt = new Date().toISOString();
      const actualExecutionLatencyMs = Date.now() - executionStartedAtMs;
      const assistantText = uiMessageText(responseMessage);
      const actualInputTokens = executionEstimate.expectedInputTokens;
      const actualOutputTokens = estimateTokens(assistantText);
      const actualTotalTokens = actualInputTokens + actualOutputTokens;
      const latency = latencyOutcome(
        actualExecutionLatencyMs,
        executionEstimate.expectedLatencyMs,
        executionEstimate.upperLatencyMs,
      );
      const tokenDeviationCount = actualTotalTokens - executionEstimate.expectedTotalTokens;
      const tokenDeviationPct =
        executionEstimate.expectedTotalTokens > 0
          ? (tokenDeviationCount / executionEstimate.expectedTotalTokens) * 100
          : null;
      const tokenResult = classifyTokens(actualTotalTokens, executionEstimate.expectedTotalTokens);
      await completeExecutionRun(executionRunId, {
        completedAt,
        actualInputTokens,
        actualOutputTokens,
        actualTotalTokens,
        actualExecutionLatencyMs,
        latencyDeviationMs: latency.deviationMs,
        latencyDeviationPct: latency.deviationPct,
        tokenDeviationCount,
        tokenDeviationPct,
        latencyResult: latency.result,
        tokenResult,
        success: !isAborted,
      });
      // Build the complete response message by adding:
      // 1. Routing decision parts (for the recommend-accept path, emitted live in execute)
      // 2. Telemetry parts (router-execution-outcome)
      // This ensures the assistant message in DB + client state has the routing decision
      // bubble visible both in the live stream AND after reload.
      const responseWithRoutingDecision = {
        ...responseMessage,
        parts: [...responseMessage.parts, ...routingDecisionParts],
      } as UIMessage;
      const responseWithTelemetry = {
        ...responseWithRoutingDecision,
        parts: [
          ...responseWithRoutingDecision.parts,
          {
            type: "data-router-execution-outcome",
            data: {
              runId: executionRunId,
              actual_execution_latency_ms: actualExecutionLatencyMs,
              actual_input_tokens: actualInputTokens,
              actual_output_tokens: actualOutputTokens,
              actual_total_tokens: actualTotalTokens,
              latency_deviation_ms: latency.deviationMs,
              latency_deviation_pct: latency.deviationPct,
              token_deviation_count: tokenDeviationCount,
              token_deviation_pct: tokenDeviationPct,
              latency_result: latency.result,
              token_result: tokenResult,
              completed_at: completedAt,
            },
          },
        ],
      } as UIMessage;
      if (!threadId || !isDbConfigured()) return;
      try {
        const persistedAssistant = await persistAssistantMessage(
          threadId,
          responseWithTelemetry,
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
