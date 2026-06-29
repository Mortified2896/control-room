import "server-only";

import { generateText, Output, stepCountIs } from "ai";
import { z } from "zod/v4";
import { getEffectiveModelsResponse } from "@/lib/providers/registry";
import { getModelMeta, resolveModel } from "@/lib/providers";
import { getRuntimeModel, getRuntimeProviderOptions } from "@/lib/providers/runtime";
import { getEffectiveRouterSettings } from "@/lib/router/settings-store";
import { buildRouterFallbackChain, pickRouterModelForRun } from "@/lib/router/schema";
import {
  buildNormalChatRecommenderPrompt,
  type NormalChatAvailableModel,
} from "@/lib/router/normal-chat-prompts";

import { UNKNOWN_REASONING_CAPABILITY } from "@/lib/providers/capability";
import {
  proposeSubscriptionFallbacks,
  type ProposedSubscriptionFallback,
} from "@/lib/policy/no-api-billing-fallback";

export const dynamic = "force-dynamic";

type RecommendationResponse = {
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
  diagnostics: {
    recommenderProvider: string;
    recommenderModelId: string;
    fallback: boolean;
    fallbackReason: string | null;
    attemptedCandidateModel: string | null;
    /**
     * Which rung of the cost-safety fallback chain produced the
     * active recommender (`configured` / `codex` / `minimax` /
     * `openai`). `null` when no candidate succeeded.
     */
    recommenderSource: "configured" | "codex" | "minimax" | "openai" | "fallback" | null;
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
    fallbackChain: ReadonlyArray<{ providerId: string; modelId: string }>;
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

function fallbackResponse(
  input: z.infer<typeof bodySchema>,
  recommender: { provider: string; modelId: string },
  attemptedCandidateModel: string | null,
  chain: ReadonlyArray<{ providerId: string; modelId: string }> = [],
  source: "configured" | "codex" | "minimax" | "openai" | "fallback" = "fallback",
  resolutionReason: string | null = null,
): RecommendationResponse {
  return {
    // The current model id is the LAST-resort we surface to the UI
    // when the recommender cannot produce a fresh pick. The no-API-
    // billing-fallback policy says we must never SILENTLY substitute
    // a different model; `loudFailure: true` flags the response as a
    // ask-the-user situation, and `proposedSubscriptionFallbacks`
    // lists the only acceptable alternatives.
    recommendedModelId: input.currentModelId ?? "gpt-5.4-mini",
    recommendedProvider: input.currentProvider ?? "openai",
    recommendedReasoningLevel: input.currentReasoningLevel ?? null,
    reasoning: "The recommender could not run. Control Room will not auto-substitute a different model.",
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
  // Cost-safety: build the deterministic fallback chain. Subscription
  // providers first (Codex, MiniMax), OpenAI API LAST and only when
  // the user has explicitly opted in via `allowOpenAiApiRouter`.
  // `pickRouterModelForRun` walks the chain and surfaces the chosen
  // provider/model in `diagnostics` so callers can tell when OpenAI
  // was used.
  //
  // The configured recommender model id is `settings.normalChatRecommenderModelId`
  // (separate from `settings.routerModelId`, which is used by the Side B
  // A/B router). The Settings UI lets the user pick the recommender
  // model independently of the A/B router model.
  const chain = buildRouterFallbackChain({
    configuredRouterModelId: settings.normalChatRecommenderModelId,
    allowedCombos: settings.allowedCombos,
    allowOpenAiApiRouter: settings.allowOpenAiApiRouter,
    codexDefault: "codex:gpt-5.4-mini",
    minimaxDefault: "MiniMax-M3",
    openaiDefault: "gpt-5.4-mini",
  });
  let attemptedCandidateModel: string | null = null;
  let activeRecommender: { provider: "openai" | "codex" | "minimax"; modelId: string } =
    // Initialized lazily by `pickRouterModelForRun`'s resolver.
    // The narrow types are needed for the success-response block
    // below; we throw before accessing them if no candidate
    // succeeded.
    null as unknown as { provider: "openai" | "codex" | "minimax"; modelId: string };
  // Cache the resolved provider/model from the chain walker so we
  // don't need to re-resolve the same id (TS can't narrow the
  // closure-assigned variable, but `resolvedActiveRecommender` is
  // a fresh local we control).
  let resolvedActiveRecommender: {
    providerId: "openai" | "minimax" | "codex";
    modelId: string;
  } | null = null;
  let recommenderSource: "configured" | "codex" | "minimax" | "openai" | "fallback" = "fallback";
  let recommenderResolutionReason = "All candidates failed.";

  try {
    const modelsPayload = await getEffectiveModelsResponse();
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
    const availableModels: ReadonlyArray<NormalChatAvailableModel> = modelsPayload.models
      .filter((m) => m.enabled)
      .filter((m) => allowedSet === null || allowedSet.has(m.modelId))
      .map((m) => {
        // The recommender picker is effort-level only — thinking-
        // budget models (MiniMax M3 etc.) get surfaced as
        // `supportsReasoningControls: false` so the recommender
        // never picks an effort value for them. The runtime
        // adapter translates the user's `thinkingMode` pick into
        // provider-native reasoning controls separately.
        const isCodex = m.providerId === "codex";
        const isEffortLevels =
          m.reasoningCapability.kind === "effort_levels" &&
          m.reasoningCapability.control !== "unknown";
        return {
          provider: m.providerId,
          modelId: m.modelId,
          displayLabel: m.modelLabel,
          // Codex is intentionally excluded because the Codex agent
          // backend is a separate transport; the chat composer hands
          // off to it via `CodexChatPane` rather than the regular
          // `/api/chat` route. MiniMax is excluded because its
          // capability is `thinking_budget`, not effort-level.
          supportsReasoningControls: !isCodex && isEffortLevels,
          // Provider-native option values, NOT the narrow
          // `ReasoningLevel` enum.
          allowedReasoningLevels:
            !isCodex && isEffortLevels
              ? m.reasoningCapability.kind === "effort_levels"
                ? m.reasoningCapability.options.map((o) => o.value)
                : []
              : [],
          enabled: m.enabled,
          accessPath: m.accessPath ?? null,
          tier: m.tier,
        };
      });

    if (availableModels.length === 0) {
      // Either every model is disabled, or the user has explicitly
      // allowed zero models. Fail loud rather than send an empty list
      // to the recommender (which would either crash or recommend a
      // random id).
      return Response.json(
        fallbackResponse(
          input,
          activeRecommender ?? { provider: "codex", modelId: "codex:gpt-5.4-mini" },
          attemptedCandidateModel,
          chain.map((c) => ({ providerId: c.providerId, modelId: c.modelId })),
          recommenderSource,
          allowlist === null
            ? "No enabled chat models are available for the recommender."
            : "No models are enabled for the recommender — update Settings → Router → Model Registry to allow at least one model.",
        ),
      );
    }

    // Walk the chain. For each candidate, try to resolve the
    // provider/model id to a runtime-invokable shape. The
    // `resolve_failed_*` reasons are how the chain advances past
    // a model that the registry refuses to surface (e.g. Codex
    // gated off in Settings) — the next candidate gets tried
    // without ever calling OpenAI.
    const resolution = await pickRouterModelForRun({
      chain,
      allowOpenAiApiRouter: settings.allowOpenAiApiRouter,
      resolver: async (candidate) => {
        const resolved = resolveModel(candidate.modelId);
        if (!resolved.ok) {
          return {
            ok: false as const,
            reason: `resolve_failed:${resolved.error.kind}`,
          };
        }
        activeRecommender = {
          provider: candidate.providerId,
          modelId: candidate.modelId,
        };
        resolvedActiveRecommender = resolved.resolved;
        return { ok: true as const };
      },
    });
    if (!resolution.ok) {
      recommenderResolutionReason = resolution.reason;
      throw new Error(recommenderResolutionReason);
    }
    recommenderSource = resolution.source;
    recommenderResolutionReason = resolution.reason;

    if (!activeRecommender || !resolvedActiveRecommender) {
      throw new Error("active_recommender_unset_after_resolution");
    }

    // Build the prompt via the shared helper so the API route and the
    // Settings UI render the same prompt body. The user prompt is
    // JSON-serialized so the model can parse it deterministically.
    const prompt = buildNormalChatRecommenderPrompt({
      mode: input.mode,
      message: input.message,
      current: {
        modelId: input.currentModelId ?? null,
        provider: input.currentProvider ?? null,
        reasoningLevel: input.currentReasoningLevel ?? null,
      },
      availableModels,
    });

    // Snapshot to a local const so TS can narrow the mutable outer let
    // through this call site (the IIFE below loses narrowing).
    const resolvedRecommender = resolvedActiveRecommender as {
      providerId: "openai" | "minimax" | "codex";
      modelId: string;
      billingSource: import("@/lib/providers/types").BillingSource;
    } | null;
    const recommenderProviderOptions: ReturnType<typeof getRuntimeProviderOptions> = (() => {
      if (!resolvedRecommender) return undefined;
      const recommenderMeta = getModelMeta(resolvedRecommender.modelId);
      const capability = recommenderMeta?.reasoningCapability ?? UNKNOWN_REASONING_CAPABILITY;
      // Pass the configured value verbatim. The runtime adapter
      // validates against the capability's `options` list and
      // forwards the value unchanged to the provider.
      return getRuntimeProviderOptions({
        resolved: resolvedRecommender,
        capability,
        reasoningOption: settings.normalChatRecommenderReasoningLevel,
      });
    })();

    const result = await generateText({
      model: getRuntimeModel(resolvedActiveRecommender),
      system: prompt.system,
      prompt: prompt.user,
      output: Output.object({ schema: outputSchema, name: "normal_chat_model_recommendation" }),
      stopWhen: stepCountIs(1),
      // Honor the user-configured reasoning level for the recommender
      // itself. The runtime adapter returns `undefined` for unknown
      // / non-effort-level capabilities (Codex / MiniMax unknown
      // discovery, etc.) so this is a no-op when the recommender
      // cannot accept reasoning controls.
      ...(recommenderProviderOptions ? { providerOptions: recommenderProviderOptions } : {}),
    });

    const value = result.output;
    attemptedCandidateModel = value?.recommendedModelId ?? null;
    const picked = value
      ? availableModels.find(
          (m) => m.modelId === value.recommendedModelId && m.provider === value.recommendedProvider,
        )
      : null;
    if (!value || !picked) throw new Error("invalid_recommendation");
    const level = picked.supportsReasoningControls ? value.recommendedReasoningLevel : null;
    if (level && !picked.allowedReasoningLevels.includes(level))
      throw new Error("invalid_reasoning_level");

    return Response.json({
      ...value,
      recommendedReasoningLevel: level,
      alternatives: value.alternatives?.filter((a) =>
        availableModels.some((m) => m.modelId === a.modelId && m.provider === a.provider),
      ),
      diagnostics: {
        recommenderProvider: activeRecommender.provider,
        recommenderModelId: activeRecommender.modelId,
        fallback: false,
        fallbackReason: null,
        attemptedCandidateModel,
        recommenderSource,
        recommenderResolutionReason,
        fallbackChain: chain.map((c) => ({
          providerId: c.providerId,
          modelId: c.modelId,
        })),
      },
    } satisfies RecommendationResponse);
  } catch (err) {
    // Safe diagnostics only: never log secrets or request headers.
    console.error("[model/recommend] fallback", {
      chain: chain.map((c) => `${c.providerId}:${c.modelId}`),
      attemptedCandidateModel,
      reason: err instanceof Error ? err.message : String(err),
    });
    // Loud failure under the NO_API_BILLING_FALLBACK policy. We
    // never auto-substitute — the response surfaces subscription
    // proposals the user can explicitly opt into, plus a clear
    // reason. Codex is preferred as a proposal when Codex is
    // available (subscription-only chain), otherwise MiniMax.
    const requested = input.currentModelId ?? "gpt-5.4-mini";
    const requestedProvider = (input.currentProvider ?? "openai") as
      | "openai"
      | "minimax"
      | "codex";
    const requestedBillingSource: import("@/lib/providers/types").BillingSource =
      requestedProvider === "openai" ? "api_billing" : "subscription";
    const proposals: ProposedSubscriptionFallback[] = proposeSubscriptionFallbacks({
      requestedModelId: requested,
      requestedProviderId: requestedProvider,
      candidates: [
        {
          providerId: "codex",
          modelId: "codex:gpt-5.4-mini",
          modelLabel: "Codex · GPT-5.4 Mini",
          tier: "cheap",
          reasoningCapability: { kind: "none", control: "unsupported" },
          reasoningLevels: [],
          billingSource: "subscription",
        },
        {
          providerId: "minimax",
          modelId: "MiniMax-M3",
          modelLabel: "MiniMax-M3",
          tier: "cheap",
          reasoningCapability: { kind: "thinking_budget", control: "supported" },
          reasoningLevels: [],
          billingSource: "subscription",
        },
      ],
      registry: [
        { modelId: "codex:gpt-5.4-mini", displayLabel: "Codex · GPT-5.4 Mini · Codex subscription" },
        { modelId: "MiniMax-M3", displayLabel: "MiniMax-M3 · MiniMax subscription" },
      ],
      reason:
        "The recommender runner could not produce a recommendation. " +
        "Control Room will not silently switch to an API-billed model.",
    });
    const response = fallbackResponse(
      input,
      activeRecommender ?? { provider: "codex", modelId: "codex:gpt-5.4-mini" },
      attemptedCandidateModel,
      chain.map((c) => ({ providerId: c.providerId, modelId: c.modelId })),
      recommenderSource,
      recommenderResolutionReason,
    );
    return Response.json({
      ...response,
      proposedSubscriptionFallbacks: proposals,
    } satisfies RecommendationResponse);
  }
}
