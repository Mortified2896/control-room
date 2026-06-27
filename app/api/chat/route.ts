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
import { resolveModel, getDefaultRouterModelId } from "@/lib/providers";
import { getEffectiveModelsResponse } from "@/lib/providers/registry";
import { assertModelExecutionAllowed, ProviderAccessError } from "@/lib/providers/access-control";
import {
  getRuntimeModel,
  getRuntimeProviderOptions,
  ProviderConfigurationError,
} from "@/lib/providers/runtime";
import type { ReasoningLevel } from "@/lib/providers/types";
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

function validReasoningLevel(value: unknown): ReasoningLevel {
  return value === "medium" || value === "high" ? value : "low";
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
    sideA: { modelId: string; reasoningLevel: ReasoningLevel };
    sideB: { modelId: string; reasoningLevel: ReasoningLevel } | null;
    recommendation: RouterAbRecommendationDto | null;
    usedFallback: boolean;
    fallbackReason: string | null;
    skipReason: string | null;
    shortReason: string | null;
    taskType: AbTaskType | null;
    confidence: number | null;
  };
  "router-ab-side-b": {
    sessionId: string;
    sideBText: string;
    sideBLatencyMs: number;
  };
};

type RouterAbUiMessage = UIMessage<unknown, RouterAbDataParts>;

type RouterAbRecommendationDto = {
  recommendedModel: string;
  recommendedReasoningLevel: ReasoningLevel;
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
    reasoningLevel: rawReasoningLevel,
    routerAb: routerAbOn,
  }: {
    messages: UIMessage[];
    system?: string;
    tools?: Record<string, { description?: string; parameters: JSONSchema7 }>;
    modelId?: string;
    threadId?: string;
    reasoningLevel?: string;
    routerAb?: boolean;
  } = await req.json();

  let result = resolveModel(modelId);

  if (!result.ok && result.error.kind === "unknown_model" && modelId) {
    const effectiveModels = await getEffectiveModelsResponse();
    const dynamic = effectiveModels.models.find((m) => m.modelId === modelId && m.enabled);
    if (dynamic && (dynamic.providerId === "minimax" || dynamic.providerId === "openai")) {
      result = { ok: true, resolved: { providerId: dynamic.providerId, modelId: dynamic.modelId } };
    }
  }

  if (!result.ok) {
    const err = result.error;
    if (err.kind === "no_models_available") {
      return Response.json(
        {
          error: "no_models_available",
          message: "No models are available. Configure a provider API key in .env.local.",
        },
        { status: 503 },
      );
    }
    if (err.kind === "provider_disabled") {
      return Response.json(
        {
          error: "provider_disabled",
          providerId: err.providerId,
          reason: err.reason,
        },
        { status: 503 },
      );
    }
    return Response.json(
      {
        error: "unknown_model",
        modelId: err.modelId,
        allowedIds: err.allowedIds,
      },
      { status: 400 },
    );
  }

  const reasoningLevel = validReasoningLevel(rawReasoningLevel);

  try {
    await assertModelExecutionAllowed({
      providerId: result.resolved.providerId,
      modelId: result.resolved.modelId,
      surface: "manual_chat",
      reasoningLevel,
    });
  } catch (err) {
    if (err instanceof ProviderAccessError) {
      return Response.json(
        { error: "provider_access_blocked", providerId: err.providerId, reason: err.message },
        { status: err.status },
      );
    }
    throw err;
  }

  const routerAbSupported = result.resolved.providerId === "openai";

  let sideAModel;
  let sideAProviderOptions;
  try {
    sideAModel = getRuntimeModel(result.resolved);
    sideAProviderOptions = getRuntimeProviderOptions(result.resolved, reasoningLevel);
  } catch (err: unknown) {
    if (err instanceof ProviderConfigurationError) {
      return Response.json(
        {
          error: "provider_disabled",
          providerId: err.providerId,
          reason: err.message,
        },
        { status: 503 },
      );
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

  let routerOutput: RouterGraphOutput | null = null;
  if (routerAbEnabled && settings.abEnabled) {
    try {
      await assertModelExecutionAllowed({
        providerId: "openai",
        modelId: settings.routerModelId || getDefaultRouterModelId(),
        surface: "router",
        reasoningLevel: "low",
      });
      routerOutput = await runRouterGraph({
        latestUserText: latestText,
        recentTurns,
        sideA: { modelId: result.resolved.modelId, reasoningLevel },
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
        sideAReasoningLevel: reasoningLevel,
        userPromptText: latestText,
        recentChars,
        routerModelId: settings.routerModelId || getDefaultRouterModelId(),
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
        reasoningLevel,
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
            sideA: { modelId: result.resolved.modelId, reasoningLevel },
            sideB: routerOutput?.sideB ?? null,
            recommendation: routerAbRecommendationFromOutput(routerOutput),
            usedFallback: routerOutput?.usedFallback ?? false,
            fallbackReason: routerOutput?.fallbackReason ?? null,
            skipReason: routerOutput?.skipReason ?? null,
            shortReason: routerOutput?.recommendation?.shortReason ?? null,
            taskType: routerOutput?.recommendation?.taskType ?? null,
            confidence: routerOutput?.recommendation?.confidence ?? null,
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
  reasoningLevel: ReasoningLevel;
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
  reasoningLevel: ReasoningLevel;
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
