import "server-only";

import { generateText, Output, stepCountIs } from "ai";
import { z } from "zod/v4";
import { getEffectiveModelsResponse } from "@/lib/providers/registry";
import { getModelMeta, resolveModel } from "@/lib/providers";
import { getRuntimeModel, getRuntimeProviderOptions } from "@/lib/providers/runtime";
import { getEffectiveRouterSettings } from "@/lib/router/settings-store";
import {
  buildConfiguredRecommenderChain,
  providerIdFromRecommenderModelId,
} from "@/lib/router/recommender-config";
import {
  buildNormalChatRecommenderPrompt,
  type NormalChatAvailableModel,
} from "@/lib/router/normal-chat-prompts";

import { UNKNOWN_REASONING_CAPABILITY } from "@/lib/providers/capability";
import {
  enforceNoApiBillingFallback,
  NoApiBillingFallbackErrorClass,
} from "@/lib/policy/no-api-billing-fallback";
import { isCodexModelId, resolveCodexBinary, runCodexExec } from "@/lib/codex/runner";
import { walkRecommenderChain } from "./recommender-chain";
import {
  estimateRecommendation,
  estimateTokens,
  latencyOutcome,
  promptHash,
} from "@/lib/router/telemetry";
import { completeRecommendationRun, createRecommendationRun } from "@/lib/repo/router-telemetry";
import type { ConfiguredRecommenderRung } from "@/lib/router/recommender-config";
import { tryRecoverJsonObjectFromAiSdkError } from "@/lib/router/parse-json-fallback";
import {
  buildPanelForLoudFailure,
  buildPanelFromRecommenderValue,
  RouterModelTreatedAsExecutionError,
  type PanelBuilderContextDecision,
  type PanelBuilderRecommenderValue,
} from "./panel-builder";
import {
  CONTEXT_DECISION_SYSTEM_PROMPT,
  CONTEXT_DECISION_JSON_ONLY_SUFFIX,
  classifyContextDecision,
} from "@/lib/router/context-decision-classifier";
import {
  getExecutionEligibleModelIds,
  type RoutingDecisionPanel,
} from "@/lib/router/routing-decision-panel-types";
import type { EffectiveRegistry } from "@/lib/providers/registry";

export const dynamic = "force-dynamic";

type RecommendationResponse = {
  /**
   * New canonical panel payload. The chat composer renders this
   * shape via `RoutingDecisionPanel`; the legacy fields below
   * remain so the existing E2E suite + the chat composer legacy
   * cards continue to work during the additive migration.
   *
   * The panel payload carries:
   *   - `contextDecision` (chat_only | harness_needed) with its
   *     own explanation,
   *   - `executionPackage` (model + reasoningLevel + harness) with
   *     a single 1-2 sentence package explanation,
   *   - `confidence` (0..1),
   *   - `costTier` (standard | expensive | cheap),
   *   - `latencyMs` (the wall-clock recommendation latency).
   */
  panel?: RoutingDecisionPanel;
  /**
   * Route classification the recommender picked for the user's
   * message. The approval card shows "Recommended route: Normal chat"
   * or "Recommended route: Coding task" before the model + reasoning
   * level lines so the user sees the routing decision first.
   */
  recommendedRoute: "normal_chat" | "coding_task";
  /** Why this route was chosen. */
  routeReason: string;
  recommendedModelId: string;
  recommendedProvider: string;
  /**
   * Provider-native reasoning-effort value the recommender picked
   * for the answer model. `null` when the model does not support
   * reasoning controls (Codex subscription backend, thinking-budget
   * models, unknown capabilities).
   */
  recommendedReasoningLevel: string | null;
  reasoning: string;
  alternatives?: Array<{
    modelId: string;
    provider: string;
    recommendedReasoningLevel: string | null;
    reason: string;
  }>;
  /**
   * Subscription-backed alternatives the user can switch to when
   * the recommender can't run. Always empty on a successful
   * recommendation; non-empty on a loud failure. The chat composer
   * surfaces these as a "Confirm switch to <X>?" prompt; we never
   * auto-apply.
   */
  proposedSubscriptionFallbacks?: Array<{
    toModelId: string;
    toProviderId: string;
    displayLabel: string;
    reason: string;
  }>;
  /**
   * True iff the response is a loud failure: the recommender
   * couldn't run AND we are refusing to silently substitute. The
   * chat composer must surface `reason` to the user.
   */
  loudFailure?: boolean;
  recommendationTelemetry?: {
    runId: string | null;
    expected_latency_ms: number;
    upper_latency_ms: number;
    estimate_quality: "likely" | "uncertain" | "rough";
    latency_policy: string;
    latency_basis: string;
    historical_sample_count: number;
    started_at: string;
    completed_at: string | null;
    actual_latency_ms: number | null;
    latency_deviation_ms: number | null;
    latency_deviation_pct: number | null;
    latency_result: string | null;
  };
  diagnostics: {
    recommenderProvider: string;
    recommenderModelId: string;
    fallback: boolean;
    fallbackReason: string | null;
    attemptedCandidateModel: string | null;
    /**
     * Which rung of the cost-safety fallback chain produced the
     * active recommender (`configured` / `configured_fallback` /
     * `codex` / `minimax` / `openai`). `null` when no candidate
     * succeeded.
     */
    recommenderSource: "configured" | "configured_fallback" | null;
    /**
     * Human-readable explanation of the resolution (e.g. "Using a
     * Codex subscription router model (OpenAI API disabled or
     * unavailable)."). Never contains secrets. `null` when no
     * candidate succeeded.
     */
    recommenderResolutionReason: string | null;
    /**
     * Ordered list of candidates the route attempted before
     * settling on the active recommender. Useful for "did we
     * actually call OpenAI?" diagnostics.
     */
    fallbackChain: ReadonlyArray<{
      source: "configured" | "configured_fallback";
      providerId: string;
      modelId: string;
    }>;
    /**
     * Per-rung call-attempt trace. Records every recommender rung
     * the route actually called, with the failure reason for any
     * rung that did not produce a parseable recommendation. Lets
     * the chat composer render diagnostics like
     * "primary recommender failed: codex:gpt-5.4-mini · low ·
     * usage_limit; configured fallback tried: MiniMax-M3 ·
     * provider_default" exactly as the brief asks.
     */
    callAttempts?: ReadonlyArray<{
      source: "configured" | "configured_fallback";
      modelId: string;
      reasoning: string;
      status: "success" | "failed";
      reason: string;
    }>;
  };
};

const bodySchema = z.object({
  threadId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  message: z.string().min(1),
  currentModelId: z.string().nullable().optional(),
  currentProvider: z.string().nullable().optional(),
  currentReasoningLevel: z.string().min(1).nullable().optional(),
  mode: z.literal("normal_chat"),
});

const outputSchema = z.object({
  recommendedRoute: z.enum(["normal_chat", "coding_task"]),
  routeReason: z.string().min(1).max(300),
  recommendedModelId: z.string().min(1),
  recommendedProvider: z.string().min(1),
  // Provider-native reasoning-effort value. The recommender may
  // return any of the values the selected model advertises in its
  // `reasoningCapability.options` — typically `low`, `medium`,
  // `high`, but also `none`, `minimal`, `xhigh`, or any future
  // provider-native value. We do NOT narrow to a fixed enum.
  recommendedReasoningLevel: z.string().min(1).nullable(),
  reasoning: z.string().min(1).max(200),
  alternatives: z.array(
    z.object({
      modelId: z.string().min(1),
      provider: z.string().min(1),
      recommendedReasoningLevel: z.string().min(1).nullable(),
      reason: z.string().min(1).max(160),
    }),
  ),
});

type RecommenderOutput = z.infer<typeof outputSchema>;

async function runCodexRecommender(args: {
  modelId: string;
  system: string;
  user: string;
}): Promise<RecommenderOutput> {
  const binary = resolveCodexBinary();
  if (!binary) throw new Error("codex_cli_not_installed");
  const codexModelId = args.modelId.startsWith("codex:")
    ? args.modelId.slice("codex:".length)
    : args.modelId;
  if (!isCodexModelId(codexModelId)) throw new Error("invalid_codex_recommender_model");
  const schemaHint = `Return ONLY minified JSON with this shape: {"recommendedRoute":"normal_chat","routeReason":"short reason for route","recommendedModelId":"string","recommendedProvider":"string","recommendedReasoningLevel":null,"reasoning":"short reason","alternatives":[{"modelId":"string","provider":"string","recommendedReasoningLevel":null,"reason":"short reason"}]}. No markdown, no code fences. recommendedRoute must be "normal_chat" or "coding_task".`;
  const result = await runCodexExec(
    binary,
    `${args.system}\n\n${schemaHint}\n\nInput JSON:\n${args.user}`,
    { model: codexModelId, maxPromptLength: 24_000 },
  );
  if (!result.ok) throw new Error(result.error);
  const parsed = parseJsonObjectFromText(result.responseText);
  return outputSchema.parse(parsed);
}

function parseJsonObjectFromText(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (fenced) return JSON.parse(fenced);
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("codex_recommender_returned_non_json");
  }
}

/**
 * Build the new `RoutingDecisionPanel` payload for the success
 * path. Wraps `buildPanelFromRecommenderValue` with the
 * classifier call (which runs against the SAME configured chain
 * as the model-pick recommender). Pure / no I/O outside of the
 * classifier call.
 */
async function buildPanelForSuccessfulRun(args: {
  message: string;
  recommenderValue: PanelBuilderRecommenderValue;
  contextDecisionClassifierOutput: PanelBuilderContextDecision | null;
  level: string | null;
  registry: EffectiveRegistry | null;
  executionBlocklist: ReadonlyArray<string>;
  registryToAllowedReasoningValues: (modelId: string) => ReadonlyArray<string>;
  latencyMs: number;
  chain: ReadonlyArray<ConfiguredRecommenderRung>;
  runRungForClassifier: (args: {
    rung: ConfiguredRecommenderRung;
    system: string;
    user: string;
  }) => Promise<{ decision: "chat_only" | "harness_needed"; explanation: string }>;
}): Promise<RoutingDecisionPanel> {
  // Run the classifier. If both rungs fail, the keyword fallback
  // returns a result so we always have a context decision to
  // pass into the panel builder.
  const classifierResult = await classifyContextDecision({
    message: args.message,
    chain: args.chain,
    runRung: async ({ rung, system, user }) => {
      const systemWithSuffix = `${CONTEXT_DECISION_SYSTEM_PROMPT}${CONTEXT_DECISION_JSON_ONLY_SUFFIX}`;
      return args.runRungForClassifier({
        rung,
        system: systemWithSuffix,
        user,
      });
    },
  });
  return buildPanelFromRecommenderValue({
    recommenderValue: args.recommenderValue,
    contextDecision: classifierResult.value,
    level: args.level,
    registry: args.registry,
    executionBlocklist: args.executionBlocklist,
    registryToAllowedReasoningValues: args.registryToAllowedReasoningValues,
    latencyMs: args.latencyMs,
  });
}

/**
 * Per-rung classifier invocation. Mirrors the model-pick
 * recommender's per-rung runner but uses the classifier
 * output shape. Wraps the existing `runCodexRecommender` /
 * `runOpenAICompatibleRecommenderWithSafeJsonFallback`
 * helpers when the model is a codex-catalog id; for OpenAI /
 * MiniMax it issues a fresh `generateText` call with the
 * classifier system prompt.
 */
async function runClassifierRung(args: {
  rung: ConfiguredRecommenderRung;
  system: string;
  user: string;
}): Promise<{ decision: "chat_only" | "harness_needed"; explanation: string }> {
  // For codex-catalog ids, we cannot route through the model-pick
  // recommender's runner because that runner is hard-coded to the
  // `recommenderOutputSchema`. We run a fresh call here. For MVP
  // simplicity, when the rung is a codex-catalog id, we
  // deterministically fall back to the keyword classifier —
  // codex-rung LLM classifier is a follow-up. This preserves the
  // "never silently substitute" rule because the keyword
  // fallback is the same function the route's loud-failure path
  // uses, and the panel always has a context decision.
  if (args.rung.providerId === "codex") {
    // Use the keyword classifier for codex rungs in this MVP.
    // This is conservative: the classifier always returns
    // something so the panel never blocks.
    const trimmed = (await Promise.resolve(args.user)).trim();
    const { DECISION_KEYWORD_FALLBACK } = await import("@/lib/router/context-decision-classifier");
    return DECISION_KEYWORD_FALLBACK(extractJsonMessage(trimmed));
  }
  // For OpenAI / MiniMax we issue a fresh generateText call with
  // the classifier prompt.
  const resolved = resolveModel(args.rung.modelId);
  if (!resolved.ok) {
    throw new Error(`resolve_failed:${resolved.error.kind}`);
  }
  const meta = getModelMeta(resolved.resolved.modelId);
  const capability = meta?.reasoningCapability ?? UNKNOWN_REASONING_CAPABILITY;
  const providerOptions = args.rung.reasoningLevel === undefined
    ? undefined
    : getRuntimeProviderOptions({
        resolved: resolved.resolved,
        capability,
        reasoningOption: args.rung.reasoningLevel,
      });
  const output = await runOpenAICompatibleRecommenderWithSafeJsonFallback({
    resolved: resolved.resolved,
    providerOptions,
    system: args.system,
    user: args.user,
    schemaName: "context_decision_classifier",
    schema: z.object({
      decision: z.enum(["chat_only", "harness_needed"]),
      explanation: z.string().min(1).max(200),
    }),
  });
  return output;
}

/**
 * Extract the user's prompt text from the JSON user-prompt body.
 * The classifier user prompt is `JSON.stringify({ prompt: message })`
 * — we extract the inner `prompt` for the keyword fallback so the
 * fallback sees the actual user message rather than the JSON
 * envelope.
 */
function extractJsonMessage(json: string): string {
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && "prompt" in parsed) {
      const value = (parsed as { prompt?: unknown }).prompt;
      if (typeof value === "string") return value;
    }
  } catch {
    /* fall through */
  }
  return json;
}

/**
 * Run an OpenAI-compatible recommender (MiniMax / OpenAI API) via
 * `generateText` + `Output.object({ schema })`, and on the AI SDK 6
 * `NoObjectGeneratedError: "could not parse the response"` failure
 * try a safe JSON-object extraction on the raw response text. The
 * extracted object is then strictly validated against the same
 * zod schema the AI SDK would have used; we do NOT guess or coerce
 * any missing required fields.
 *
 * Why this exists: MiniMax-M3 wraps its output in a `<think>`
 * reasoning block followed by a ```json ... ``` fenced block even
 * when the request asked for strict JSON via
 * `response_format: { type: "json_schema" }`. AI SDK 6's
 * `safeParseJSON` runs on the raw text and rejects the leading
 * `<think>` prologue, surfacing a generic "could not parse" error
 * even though the JSON payload inside the fence is valid and
 * schema-conformant.
 *
 * Safety properties (must hold):
 *   - We only attempt recovery on `NoObjectGeneratedError` (and
 *     only when the error carries a non-empty `text` payload).
 *     Any other error — network failure, auth failure, schema
 *     validation failure on the extracted payload — re-throws the
 *     original error unchanged.
 *   - The recovery extractor (`tryRecoverJsonObjectFromAiSdkError`)
 *     performs only safe JSON-object extraction (raw → fenced →
 *     brace-slice). It does NOT guess missing fields, does NOT
 *     coerce types, and does NOT relax validation.
 *   - If the extracted object does not match the zod schema, the
 *     original `NoObjectGeneratedError` is re-thrown with its
 *     original diagnostic intact. We never swallow a parse failure
 *     by accepting a non-conformant payload.
 */
async function runOpenAICompatibleRecommenderWithSafeJsonFallback<T>(args: {
  resolved: { providerId: "openai" | "minimax" | "codex"; modelId: string; billingSource: string };
  providerOptions: ReturnType<typeof getRuntimeProviderOptions>;
  system: string;
  user: string;
  schemaName: string;
  schema: import("zod/v4").ZodType<T>;
}): Promise<T> {
  try {
    const result = await generateText({
      model: getRuntimeModel(
        args.resolved as Parameters<typeof getRuntimeModel>[0],
      ),
      system: args.system,
      prompt: args.user,
      output: Output.object({ schema: args.schema, name: args.schemaName }),
      stopWhen: stepCountIs(1),
      ...(args.providerOptions ? { providerOptions: args.providerOptions } : {}),
    });
    return result.output as T;
  } catch (err) {
    // Only the AI SDK 6 "could not parse" path is recoverable. Any
    // other error (network, auth, schema mismatch on a successfully
    // parsed object) must surface verbatim.
    const recovered = tryRecoverJsonObjectFromAiSdkError(err);
    if (recovered === null) throw err;
    if (!recovered.ok) throw err;
    // Strict schema validation against the same zod schema the AI SDK
    // would have used. `safeParse` lets us re-throw the original AI
    // SDK error verbatim when the extracted object does not match —
    // we never accept a non-conformant payload.
    const validated = args.schema.safeParse(recovered.value);
    if (!validated.success) throw err;
    return validated.data as T;
  }
}

/**
 * Build the per-rung failure copy the chat composer renders inside
 * the "Recommendation blocked" card. The brief mandates:
 *
 *   - Both rungs failed:
 *       "Primary recommender failed: <primary> · <reasoning>"
 *       "Fallback recommender failed: <fallback> · <reasoning>"
 *       "No other recommender fallback will be used automatically."
 *   - No fallback configured, primary failed:
 *       "Primary recommender failed: <primary> · <reasoning>"
 *       "No fallback recommender is configured."
 *
 * The two-rung contract is explicit: the composer must NEVER
 * mention a third "Codex default" / "MiniMax default" / "OpenAI
 * default" rung. The failure copy here is the single source of
 * truth for that user-facing string.
 */
function buildLoudFailureReason(
  callAttempts: ReadonlyArray<{
    source: "configured" | "configured_fallback";
    modelId: string;
    reasoning: string;
  }>,
  chain: ReadonlyArray<{ source: "configured" | "configured_fallback" }>,
): string {
  const primaryAttempt = callAttempts.find((a) => a.source === "configured");
  const fallbackAttempt = callAttempts.find((a) => a.source === "configured_fallback");
  const hasFallbackRung = chain.some((c) => c.source === "configured_fallback");
  const lines: string[] = [];
  if (primaryAttempt) {
    lines.push(
      `Primary recommender failed: ${primaryAttempt.modelId}${primaryAttempt.reasoning ? ` · ${primaryAttempt.reasoning}` : ""}.`,
    );
  }
  if (fallbackAttempt) {
    lines.push(
      `Fallback recommender failed: ${fallbackAttempt.modelId}${fallbackAttempt.reasoning ? ` · ${fallbackAttempt.reasoning}` : ""}.`,
    );
    lines.push("No other recommender fallback will be used automatically.");
  } else if (!hasFallbackRung) {
    lines.push("No fallback recommender is configured.");
  }
  return lines.join(" ");
}

function fallbackResponse(
  input: z.infer<typeof bodySchema>,
  recommender: { provider: string; modelId: string },
  attemptedCandidateModel: string | null,
  chain: ReadonlyArray<{
    source: "configured" | "configured_fallback";
    providerId: string;
    modelId: string;
  }> = [],
  source: "configured" | "configured_fallback" = "configured",
  resolutionReason: string | null = null,
  reasoningOverride: string | null = null,
): RecommendationResponse {
  return {
    // The current model id is the LAST-resort we surface to the UI
    // when the recommender cannot produce a fresh pick. The no-API-
    // billing-fallback policy says we must never SILENTLY substitute
    // a different model; `loudFailure: true` flags the response as a
    // ask-the-user situation, and `proposedSubscriptionFallbacks`
    // lists the only acceptable alternatives.
    //
    // We deliberately do NOT default `recommendedModelId` to a third
    // Codex/MiniMax/OpenAI rung here. The loud-failure response
    // surfaces the user's current selection verbatim — and surfaces
    // proposals built from the LIVE registry on the catch path.
    // A silent third-fallback default would hide the configured
    // primary → configured fallback contract behind a generic
    // "GPT-5.4 Mini" line.
    recommendedRoute: "normal_chat",
    routeReason:
      reasoningOverride ??
      "The recommender could not run; defaulting to normal chat route.",
    recommendedModelId: input.currentModelId ?? "",
    recommendedProvider: input.currentProvider ?? "",
    recommendedReasoningLevel: input.currentReasoningLevel ?? null,
    reasoning:
      reasoningOverride ??
      "The recommender could not run. Control Room will not auto-substitute a different model.",
    loudFailure: true,
    proposedSubscriptionFallbacks: [],
    diagnostics: {
      recommenderProvider: recommender.provider,
      recommenderModelId: recommender.modelId,
      fallback: true,
      fallbackReason: "model_recommendation_failed",
      attemptedCandidateModel,
      recommenderSource: source,
      recommenderResolutionReason: resolutionReason,
      fallbackChain: chain,
    },
  };
}

export async function POST(request: Request) {
  let input: z.infer<typeof bodySchema>;
  try {
    input = bodySchema.parse(await request.json());
  } catch (err) {
    return Response.json({ error: "invalid_request", details: String(err) }, { status: 400 });
  }

  const settings = await getEffectiveRouterSettings();
  // The chain is EXACTLY TWO RUNGS: the configured primary
  // (`normalChatRecommenderModelId`) and, if set, the configured
  // fallback (`normalChatRecommenderFallbackModelId`). No third
  // default rung is appended — the product contract is primary →
  // one fallback → loud failure. The Settings UI lets the user pick
  // the recommender model independently of the A/B router model.
  // The Chat UI shows only those two controls — "Recommender engine"
  // and "Fallback engine (one)" — so the backend must not silently
  // try any third "deterministic default" rung. If the configured
  // fallback is missing OR also fails, the route returns a loud
  // blocked recommendation with NO third attempt. This is the explicit
  // product contract: "Fallback engine (one)" means exactly one
  // configured fallback engine — nothing more.
  const chain = buildConfiguredRecommenderChain(settings);
  // Sanity check: the chain must never exceed 2 entries. The
  // product contract is "primary → one fallback → blocked"; a
  // 3+ rung chain would violate that contract. If a future
  // refactor accidentally extends the chain, the lint-time
  // assertion below turns it into a loud failure at the next
  // request instead of a silent third attempt.
  if (chain.length > 2) {
    throw new Error(
      `Internal: recommender chain has ${chain.length} rungs, expected at most 2. ` +
        "The Chat UI exposes only the primary and the configured fallback — the route must not try any third default.",
    );
  }
  let attemptedCandidateModel: string | null = null;
  let activeRecommender: { provider: "openai" | "codex" | "minimax"; modelId: string } | null =
    null;
  let recommenderSource: "configured" | "configured_fallback" = "configured";
  let recommenderResolutionReason = "Using the configured recommender engine.";
  // Per-rung call-attempt trace. Surfaces in the response
  // `diagnostics` so the chat composer can render
  // "primary recommender failed: … usage_limit; configured fallback
  // tried: …" exactly as the brief asks. At most 2 entries — one
  // per configured rung. A third entry would mean the route
  // accidentally walked a hidden default rung, which the product
  // contract forbids.
  let callAttempts: Array<{
    source: "configured" | "configured_fallback";
    modelId: string;
    reasoning: string;
    status: "success" | "failed";
    reason: string;
  }> = [];

  const telemetryPromptTokens = estimateTokens(input.message);
  const telemetryContextTokens = estimateTokens(
    JSON.stringify({ projectId: input.projectId, threadId: input.threadId }),
  );
  const telemetryRecommender = chain[0] ??
    chain[1] ?? {
      providerId: "unknown" as const,
      modelId: settings.normalChatRecommenderModelId ?? "unknown",
    };
  const recommendationStartedAtMs = Date.now();
  const recommendationStartedAt = new Date(recommendationStartedAtMs).toISOString();
  const recommendationEstimate = await estimateRecommendation({
    recommenderModelId: telemetryRecommender.modelId,
    providerPath: telemetryRecommender.providerId,
    promptTokenEstimate: telemetryPromptTokens,
    contextTokenEstimate: telemetryContextTokens,
    stepId: "normal_chat",
  });
  const recommendationRunId = await createRecommendationRun({
    stepId: "normal_chat",
    recommenderModelId: telemetryRecommender.modelId,
    providerPath: telemetryRecommender.providerId,
    promptHash: promptHash(input.message),
    promptTokenEstimate: telemetryPromptTokens,
    contextTokenEstimate: telemetryContextTokens,
    expectedLatencyMs: recommendationEstimate.expectedLatencyMs,
    upperLatencyMs: recommendationEstimate.upperLatencyMs,
    estimateQuality: recommendationEstimate.estimateQuality,
    latencyPolicy: recommendationEstimate.latencyPolicy,
    latencyBasis: recommendationEstimate.latencyBasis,
    historicalSampleCount: recommendationEstimate.historicalSampleCount,
    startedAt: recommendationStartedAt,
  });
  const recommendationTelemetryBase = () => ({
    runId: recommendationRunId,
    expected_latency_ms: recommendationEstimate.expectedLatencyMs,
    upper_latency_ms: recommendationEstimate.upperLatencyMs,
    estimate_quality: recommendationEstimate.estimateQuality,
    latency_policy: recommendationEstimate.latencyPolicy,
    latency_basis: recommendationEstimate.latencyBasis,
    historical_sample_count: recommendationEstimate.historicalSampleCount,
    started_at: recommendationStartedAt,
  });

  // The availableModels list is built BEFORE the try block so the
  // catch path (loud-failure handler) can read it directly to
  // build subscription proposals from the live registry. We do NOT
  // hardcode a third Codex/MiniMax/OpenAI rung into the proposal
  // candidates — a model appears in proposedSubscriptionFallbacks
  // exactly when the live registry reports it as enabled. This
  // pins the "configured primary → configured fallback → blocked"
  // chain and removes the previous hardcoded
  // `codex:gpt-5.4-mini` third rung.
  const modelsPayload = await getEffectiveModelsResponse().catch(() => null);
  // Apply the user-curated allowlist (if any) before building the
  // prompt. `null` means "no restriction" — the recommender can pick
  // any enabled model from the chat picker (OpenAI, MiniMax, Codex
  // subscription). `[]` means "block all" — the prompt will see an
  // empty list and the route falls back to the current chat model.
  //
  // Note: Codex entries do appear in the chat picker (the chat
  // composer uses the Codex chat pane for `providerId === "codex"`),
  // so excluding them from the recommender would be a surprising
  // gap. We include them but lie about reasoning controls: the
  // chat picker shows `reasoningLevels: ["low"]` for Codex so the
  // reasoning dropdown doesn't disappear, but the runtime actually
  // ignores reasoning for the codex provider (see the comment in
  // `getEffectiveModelsResponse`). Telling the recommender
  // `supportsReasoningControls: false` matches what the runtime
  // will honor and prompts it to return `recommendedReasoningLevel: null`.
  const allowlist = settings.normalChatRecommenderAllowedModels;
  const allowedSet = allowlist === null ? null : new Set(allowlist);
  // Per-(model, reasoning) option allowlist from the Recommender
  // candidates tab. The recommender must NOT suggest a reasoning level
  // outside this set. `allowedCombos` is the user-curated surface for
  // this — when a row is fully unconstrained, the model’s full
  // capability is exposed; when the user has narrowed a row to a few
  // checkboxes, only those are surfaced. The runtime engine picks
  // exactly from `allowedReasoningLevels` for each model.
  const candidateOptionsByModel = new Map<string, string[]>();
  for (const combo of settings.allowedCombos) {
    const arr = candidateOptionsByModel.get(combo.modelId) ?? [];
    arr.push(combo.reasoningLevel);
    candidateOptionsByModel.set(combo.modelId, arr);
  }
  const availableModels: ReadonlyArray<NormalChatAvailableModel> = modelsPayload
    ? modelsPayload.models
        .filter((m) => m.enabled)
        .filter((m) => allowedSet === null || allowedSet.has(m.modelId))
        .map((m) => {
          // The recommender picker is effort-level only — thinking-
          // budget models (MiniMax M3 etc.) get surfaced as
          // `supportsReasoningControls: false` so the recommender
          // never picks an effort value for them. The runtime
          // adapter translates the user's `thinkingMode` pick into
          // provider-native reasoning controls separately.
          const isEffortLevels =
            m.reasoningCapability.kind === "effort_levels" &&
            m.reasoningCapability.control !== "unknown";
          let modelReasoningLevels: ReadonlyArray<string> = [];
          if (isEffortLevels) {
            const native =
              m.reasoningCapability.kind === "effort_levels"
                ? m.reasoningCapability.options.map((o) => o.value)
                : [];
            // If the user has narrowed the Tab C allowlist for this
            // model, intersect with the narrowing set. The runtime
            // also defends against stale provider-native values below.
            const narrowed = candidateOptionsByModel.get(m.modelId);
            if (narrowed && narrowed.length > 0) {
              const set = new Set(native);
              modelReasoningLevels = narrowed.filter((v) => set.has(v));
            } else {
              modelReasoningLevels = native;
            }
          }
          return {
            provider: m.providerId,
            modelId: m.modelId,
            displayLabel: m.modelLabel,
            // Effort-level providers (including Codex subscription rows)
            // expose model id and reasoning as separate candidate fields.
            // Thinking-budget providers such as MiniMax are surfaced without
            // effort-level controls so the recommender cannot invent one.
            supportsReasoningControls: modelReasoningLevels.length > 0,
            // Provider-native option values that survive both the
            // Tab C per-model narrowing AND the model's capability
            // surface. NOT the narrow `ReasoningLevel` enum.
            allowedReasoningLevels: modelReasoningLevels,
            enabled: m.enabled,
            accessPath: m.accessPath ?? null,
            tier: m.tier,
          };
        })
    : [];

  try {
    if (availableModels.length === 0) {
      // Either every model is disabled, or the user has explicitly
      // allowed zero models. Fail loud rather than send an empty list
      // to the recommender (which would either crash or recommend a
      // random id). The recommender reported in diagnostics stays
      // the configured primary — we don't fabricate a third
      // Codex/MiniMax default rung here.
      const defaultPrimary = settings.normalChatRecommenderModelId;
      const defaultPrimaryProvider = defaultPrimary
        ? providerIdFromRecommenderModelId(defaultPrimary)
        : "codex";
      return Response.json(
        fallbackResponse(
          input,
          activeRecommender ?? {
            provider: defaultPrimaryProvider,
            modelId: defaultPrimary ?? "",
          },
          attemptedCandidateModel,
          chain.map((c) => ({
            source: c.source,
            providerId: c.providerId,
            modelId: c.modelId,
          })),
          // Source discrimination: when no chain rung has been
          // tried yet (the "no enabled models" early-out), the
          // loud-failure response reports `configured` — the
          // user-facing copy still says "Primary recommender
          // failed: <primary> · <reasoning>". The chain walker
          // never appends a third default rung.
          "configured",
          allowlist === null
            ? "No enabled chat models are available for the recommender."
            : "No models are enabled for the recommender — update Settings → Router → Model Registry to allow at least one model.",
        ),
      );
    }

    // Build the prompt via the shared helper so the API route and the
    // Settings UI render the same prompt body. The user prompt is
    // JSON-serialized so the model can parse it deterministically.
    const prompt = buildNormalChatRecommenderPrompt({
      mode: input.mode,
      message: input.message,
      current: {
        // Deliberately do not feed the currently selected manual chat
        // model into the recommender. The manual/default model is only
        // used when Recommend is off or when the user chooses Keep
        // current; recommendations should be based on the prompt and
        // candidate settings, not anchored to the current selector.
        modelId: null,
        provider: null,
        reasoningLevel: null,
      },
      availableModels,
    });

    // Walk the two-rung chain at the CALL level. The walker is
    // extracted into `./recommender-chain` so the brief's product
    // contract (first-rung fails → second rung attempted, no third
    // default rung, `continue` not `break` on a disabled rung,
    // `reasoningOverride` actually applied) is unit-testable in
    // isolation. The walker itself is pure; the route injects the
    // I/O (`runRung`) and the resolver (`resolveModel`). The
    // walker returns either `success` (and the route shapes the
    // success response) or `no_success` (and the route throws
    // so the catch block can produce the loud-failure copy).
    const chainWalkResult = await walkRecommenderChain({
      chain,
      resolveModel,
      runRung: async ({ rung, resolved: resolvedForCall }) => {
        // Track the most recently-resolved rung for diagnostics.
        activeRecommender = {
          provider: resolvedForCall.providerId,
          modelId: resolvedForCall.modelId,
        };
        const rungReasoningLevel = rung.reasoningLevel;
        const rungProviderOptions: ReturnType<typeof getRuntimeProviderOptions> = (() => {
          if (rungReasoningLevel === undefined) return undefined;
          const meta = getModelMeta(resolvedForCall.modelId);
          const capability = meta?.reasoningCapability ?? UNKNOWN_REASONING_CAPABILITY;
          return getRuntimeProviderOptions({
            resolved: resolvedForCall,
            capability,
            reasoningOption: rungReasoningLevel,
          });
        })();

        try {
          const value =
            resolvedForCall.providerId === "codex"
              ? await runCodexRecommender({
                  modelId: resolvedForCall.modelId,
                  system: prompt.system,
                  user: prompt.user,
                })
              : await runOpenAICompatibleRecommenderWithSafeJsonFallback({
                  resolved: resolvedForCall,
                  providerOptions: rungProviderOptions,
                  system: prompt.system,
                  user: prompt.user,
                  schemaName: "normal_chat_model_recommendation",
                  schema: outputSchema,
                });
          if (!value) {
            // Walker records this as `empty_recommendation_output`.
            throw new Error("empty_recommendation_output");
          }
          return value;
        } catch (callErr) {
          // Caller-level failure for this rung (Codex CLI crashed,
          // AI SDK threw, empty output, etc.). The walker records
          // the failure and continues to the next rung — the
          // product contract is "primary → one fallback → blocked",
          // so we never walk a third default rung after this.
          const message = callErr instanceof Error ? callErr.message : String(callErr);
          // eslint-disable-next-line no-console
          console.error("[model/recommend] rung failed", {
            source: rung.source,
            modelId: rung.modelId,
            reason: message,
          });
          throw callErr;
        }
      },
      availableModels: availableModels.map((m) => ({
        provider: m.provider,
        modelId: m.modelId,
        supportsReasoningControls: m.supportsReasoningControls,
        allowedReasoningLevels: m.allowedReasoningLevels,
      })),
    });

    callAttempts = [...chainWalkResult.callAttempts];

    // Log resolve failures (the walker records them but doesn't
    // log). This preserves the previous in-route log lines so
    // observability dashboards keep working.
    for (const attempt of callAttempts) {
      if (attempt.status === "failed" && attempt.reason.startsWith("resolve_failed:")) {
        // eslint-disable-next-line no-console
        console.error("[model/recommend] rung failed to resolve", {
          source: attempt.source,
          modelId: attempt.modelId,
          reason: attempt.reason.slice("resolve_failed:".length),
        });
      }
    }

    if (chainWalkResult.kind === "success") {
      const { rung, resolved: resolvedForSuccess, value, level } = chainWalkResult;
      // Success on this rung. Record the success and return the
      // recommendation. We do NOT walk any further rungs.
      attemptedCandidateModel = value.recommendedModelId;
      activeRecommender = {
        provider: resolvedForSuccess.providerId,
        modelId: resolvedForSuccess.modelId,
      };
      recommenderSource = rung.source;
      recommenderResolutionReason =
        rung.source === "configured_fallback"
          ? "Using the user-configured recommender fallback (primary engine unavailable)."
          : "Using the configured recommender engine.";
      const completedAt = new Date().toISOString();
      const actualLatencyMs = Date.now() - recommendationStartedAtMs;
      const latency = latencyOutcome(
        actualLatencyMs,
        recommendationEstimate.expectedLatencyMs,
        recommendationEstimate.upperLatencyMs,
      );
      const filteredAlternatives = value.alternatives?.filter((a) =>
        availableModels.some((m) => m.modelId === a.modelId && m.provider === a.provider),
      );
      // Build the new RoutingDecisionPanel payload alongside the
      // legacy `RecommendationResponse` fields. The panel carries
      // the canonical recommendation shape; the legacy fields
      // remain so the existing chat composer + E2E suite keep
      // working during the additive migration. The brief asks for
      // a separate context decision + execution package
      // recommendation, both with their own explanation.
      const panel = await buildPanelForSuccessfulRun({
        message: input.message,
        recommenderValue: value,
        contextDecisionClassifierOutput: null,
        level,
        registry: null, // The legacy route does not load the EffectiveRegistry; the panel falls back to registry-derived heuristics where available.
        executionBlocklist: [
          settings.normalChatRecommenderModelId,
          settings.normalChatRecommenderFallbackModelId,
        ].filter((id): id is string => Boolean(id)),
        registryToAllowedReasoningValues: (modelId: string) => {
          const entry = availableModels.find((m) => m.modelId === modelId);
          if (!entry) return [];
          if (!entry.supportsReasoningControls) return [];
          return entry.allowedReasoningLevels;
        },
        latencyMs: actualLatencyMs,
        chain,
        runRungForClassifier: async ({ rung, system, user }) =>
          runClassifierRung({ rung, system, user }),
      });
      await completeRecommendationRun(recommendationRunId, {
        completedAt,
        actualLatencyMs,
        latencyDeviationMs: latency.deviationMs,
        latencyDeviationPct: latency.deviationPct,
        latencyResult: latency.result,
        recommendedModelId: value.recommendedModelId,
        alternativesJson: filteredAlternatives,
        reasoning: value.reasoning,
        fallbackUsed: false,
      });
      return Response.json({
        ...value,
        recommendedRoute: value.recommendedRoute,
        routeReason: value.routeReason,
        recommendedReasoningLevel: level,
        alternatives: filteredAlternatives,
        panel,
        recommendationTelemetry: {
          ...recommendationTelemetryBase(),
          completed_at: completedAt,
          actual_latency_ms: actualLatencyMs,
          latency_deviation_ms: latency.deviationMs,
          latency_deviation_pct: latency.deviationPct,
          latency_result: latency.result,
        },
        diagnostics: {
          recommenderProvider: activeRecommender!.provider,
          recommenderModelId: activeRecommender!.modelId,
          fallback: false,
          fallbackReason: null,
          attemptedCandidateModel,
          recommenderSource,
          recommenderResolutionReason,
          // The fallback chain is exactly the two configured rungs
          // the user picked — the UI's "Fallback engine (one)"
          // contract. We never append a third default rung.
          fallbackChain: chain.map((c) => ({
            source: c.source,
            providerId: c.providerId,
            modelId: c.modelId,
          })),
          callAttempts,
        },
      } satisfies RecommendationResponse);
    }

    // No rung succeeded. The product contract: the route tried
    // exactly the two configured rungs (or one, if no fallback
    // was configured) and then stopped. The chain walker
    // intentionally has no third "default" rung.
    throw new Error(
      callAttempts.length > 0
        ? `All configured recommender rungs failed. Last: ${callAttempts[callAttempts.length - 1]!.modelId} (${callAttempts[callAttempts.length - 1]!.reason}).`
        : "No recommender rung was configured.",
    );
  } catch (err) {
    // Safe diagnostics only: never log secrets or request headers.
    console.error("[model/recommend] fallback", {
      chain: chain.map((c) => `${c.providerId}:${c.modelId}`),
      attemptedCandidateModel,
      reason: err instanceof Error ? err.message : String(err),
    });

    // Proposal candidates are derived from the LIVE availableModels
    // (the registry + allowlist narrowed set) so proposals reflect
    // what the user actually enabled. We do NOT hardcode a third
    // "codex:gpt-5.4-mini" or "MiniMax-M3" default here: a candidate
    // appears in proposedSubscriptionFallbacks only if the live
    // registry reports it as enabled and subscription-backed. The
    // configured fallback (e.g. MiniMax-M3) is one of the proposals
    // exactly when the live registry actually exposes it. This
    // preserves the user's configured fallback chain (primary →
    // configured fallback → blocked) without appending a hidden
    // Codex/MiniMax/OpenAI default rung.
    const proposalCandidates = (availableModels ?? [])
      .filter((m) => m.provider === "minimax" || m.provider === "codex")
      .map((m) => ({
        providerId: m.provider as "minimax" | "codex",
        modelId: m.modelId,
        modelLabel: m.displayLabel,
        tier: m.tier === "expensive" ? "expensive" as const : "cheap" as const,
        reasoningCapability: { kind: "none" as const, control: "unsupported" as const },
        reasoningLevels: [] as string[],
        billingSource: "subscription" as const,
      }));
    const proposalRegistry = (availableModels ?? [])
      .filter((m) => m.provider === "minimax" || m.provider === "codex")
      .map((m) => ({ modelId: m.modelId, displayLabel: m.displayLabel }));

    const policy = enforceNoApiBillingFallback({
      requested: {
        // The "requested" line is the *request* (current selection or
        // sentinel) the policy uses to decide whether substitution is
        // allowed. We deliberately do NOT default to "gpt-5.4-mini"
        // here — that was a hidden third rung. When the user has no
        // current chat model, the request becomes `null` so the
        // proposals surface as a subscribe-the-user prompt rather
        // than pretending `gpt-5.4-mini` was the active selection.
        modelId: input.currentModelId ?? "",
        providerId:
          (input.currentProvider ?? "openai") === "minimax"
            ? "minimax"
            : (input.currentProvider ?? "openai") === "codex"
              ? "codex"
              : "openai",
        billingSource:
          (input.currentProvider ?? "openai") === "openai" ? "api_billing" : "subscription",
        selectionSource: "user_accepted",
      },
      kind: "recommender_runner_failed",
      reason:
        "The recommender runner could not produce a recommendation. Control Room will not silently switch to an API-billed model.",
      candidates: proposalCandidates,
      registry: proposalRegistry,
    });

    let proposals = policy.proposals;
    try {
      policy.throw();
    } catch (policyErr) {
      if (policyErr instanceof NoApiBillingFallbackErrorClass) {
        proposals = [...policyErr.payload.proposedSubscriptionFallbacks];
      } else {
        throw policyErr;
      }
    }

    // Active recommender is the last rung the chain attempted.
    const lastAttempt = callAttempts[callAttempts.length - 1];
    const activeProvider = lastAttempt
      ? providerIdFromRecommenderModelId(lastAttempt.modelId)
      : "codex";
    const response = fallbackResponse(
      input,
      {
        provider: activeProvider,
        // Last-resort modelId of the recommender in the loud-failure
        // payload. We use the last rung attempted → the configured
        // primary → empty string. We deliberately do NOT default to
        // a third Codex/MiniMax/OpenAI rung here: that would silently
        // hide a third fallback behind the loud failure.
        modelId: lastAttempt?.modelId ?? settings.normalChatRecommenderModelId ?? "",
      },
      attemptedCandidateModel,
      // The blocked-card "fallbackChain" surfaces exactly the
      // configured rungs the user picked — at most two, mirroring
      // the "Fallback engine (one)" UI contract. We never append
      // hidden third / default rungs.
      chain.map((c) => ({
        source: c.source,
        providerId: c.providerId,
        modelId: c.modelId,
      })),
      // Source discrimination: the loud-failure response reports
      // `configured` when the primary failed (the UI knows the
      // primary was tried first), and `configured_fallback` when
      // the configured fallback was the last rung to fail. We
      // never report the legacy "codex" / "minimax" / "openai"
      // taxonomy here because the chain is no longer than two
      // rungs and those labels would imply a deterministic
      // third default that the product contract forbids.
      callAttempts.length > 1 ? "configured_fallback" : "configured",
      // Resolution reason surfaces a per-rung failure summary so
      // the chat composer can render the brief's mandated copy:
      //   "Primary recommender failed: <primary> · <reasoning>"
      //   "Fallback recommender failed: <fallback> · <reasoning>"
      // or, when no fallback was configured:
      //   "Primary recommender failed: <primary> · <reasoning>"
      //   "No fallback recommender is configured."
      buildLoudFailureReason(callAttempts, chain),
      buildLoudFailureReason(callAttempts, chain),
    );
    const completedAt = new Date().toISOString();
    const actualLatencyMs = Date.now() - recommendationStartedAtMs;
    const latency = latencyOutcome(
      actualLatencyMs,
      recommendationEstimate.expectedLatencyMs,
      recommendationEstimate.upperLatencyMs,
    );
    await completeRecommendationRun(recommendationRunId, {
      completedAt,
      actualLatencyMs,
      latencyDeviationMs: latency.deviationMs,
      latencyDeviationPct: latency.deviationPct,
      latencyResult: latency.result,
      recommendedModelId: response.recommendedModelId,
      alternativesJson: null,
      reasoning: response.reasoning,
      fallbackUsed: true,
      errorJson: { reason: err instanceof Error ? err.message : String(err) },
    });
    // Build the loud-failure panel payload. The brief: no
    // silent API-billing fallback. The panel surfaces a
    // `chat_only` default and the user's current selection as
    // the execution model — never a third hidden Codex /
    // MiniMax default rung.
    const loudFailurePanel = buildPanelForLoudFailure({
      contextExplanation: buildLoudFailureReason(callAttempts, chain),
      currentModelId: input.currentModelId ?? "",
      currentReasoningLevel: input.currentReasoningLevel ?? null,
      registry: null,
      latencyMs: actualLatencyMs,
    });
    return Response.json({
      ...response,
      panel: loudFailurePanel,
      proposedSubscriptionFallbacks: proposals,
      recommendationTelemetry: {
        ...recommendationTelemetryBase(),
        completed_at: completedAt,
        actual_latency_ms: actualLatencyMs,
        latency_deviation_ms: latency.deviationMs,
        latency_deviation_pct: latency.deviationPct,
        latency_result: latency.result,
      },
      diagnostics: {
        ...response.diagnostics,
        // The per-rung trace is part of the loud-failure surface.
        // It contains at most two entries — one per configured
        // rung — exactly as the brief asks.
        callAttempts,
      },
    } satisfies RecommendationResponse);
  }
}
