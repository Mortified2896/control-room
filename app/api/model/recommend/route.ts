import "server-only";

import { generateText, Output, stepCountIs } from "ai";
import { z } from "zod/v4";
import { getEffectiveModelsResponse } from "@/lib/providers/registry";
import { getModelMeta, resolveModel } from "@/lib/providers";
import { getRuntimeModel, getRuntimeProviderOptions } from "@/lib/providers/runtime";
import { getEffectiveRouterSettings } from "@/lib/router/settings-store";
import { providerIdFromModelId } from "@/lib/router/schema";
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
  const schemaHint = `Return ONLY minified JSON with this shape: {"recommendedModelId":"string","recommendedProvider":"string","recommendedReasoningLevel":null,"reasoning":"short reason","alternatives":[{"modelId":"string","provider":"string","recommendedReasoningLevel":null,"reason":"short reason"}]}. No markdown, no code fences.`;
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
 * Narrow a model id to its provider, for the two-rung recommender
 * chain. Mirrors `providerIdFromModelId` in `lib/router/schema.ts` but
 * returns `"minimax"` as the default for bare ids (the chain walker
 * never sees OpenAI here — it only walks the configured primary and
 * the configured fallback — so we narrow defensively).
 */
function providerIdFromModelIdForChain(modelId: string): "openai" | "codex" | "minimax" {
  const p = providerIdFromModelId(modelId);
  if (p === "codex" || p === "minimax") return p;
  return "openai";
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
    recommendedModelId: input.currentModelId ?? "gpt-5.4-mini",
    recommendedProvider: input.currentProvider ?? "openai",
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
  //
  // The user-configured single-model fallback
  // (`settings.normalChatRecommenderFallbackModelId`) is inserted at
  // The chain is EXACTLY TWO RUNGS: the configured primary
  // (`normalChatRecommenderModelId`) and, if set, the configured
  // fallback (`normalChatRecommenderFallbackModelId`). The Chat UI
  // shows only those two controls — "Recommender engine" and
  // "Fallback engine (one)" — so the backend must not silently try
  // any third "deterministic default" rung (no Codex default, no
  // MiniMax default, no OpenAI default, no provider default). If
  // the configured fallback is missing OR also fails, the route
  // returns a loud blocked recommendation with NO third attempt.
  // This is the explicit product contract: "Fallback engine (one)"
  // means exactly one configured fallback engine — nothing more.
  type ChainRung = {
    source: "configured" | "configured_fallback";
    providerId: "openai" | "codex" | "minimax";
    modelId: string;
    reasoningLevel: string | undefined;
    /** Free-text reason when the rung fails (omitted on success). */
    failureReason?: string;
  };
  const chain: ChainRung[] = [];
  if (settings.normalChatRecommenderModelId) {
    chain.push({
      source: "configured",
      providerId: providerIdFromModelIdForChain(settings.normalChatRecommenderModelId),
      modelId: settings.normalChatRecommenderModelId,
      reasoningLevel: settings.normalChatRecommenderReasoningLevel,
    });
  }
  if (settings.normalChatRecommenderFallbackModelId) {
    chain.push({
      source: "configured_fallback",
      providerId: providerIdFromModelIdForChain(settings.normalChatRecommenderFallbackModelId),
      modelId: settings.normalChatRecommenderFallbackModelId,
      reasoningLevel: settings.normalChatRecommenderFallbackReasoningLevel ?? undefined,
    });
  }
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
        let modelReasoningLevels: ReadonlyArray<string> = [];
        if (!isCodex && isEffortLevels) {
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
          // Codex is intentionally excluded because the Codex agent
          // backend is a separate transport; the chat composer hands
          // off to it via `CodexChatPane` rather than the regular
          // `/api/chat` route. MiniMax is excluded because its
          // capability is `thinking_budget`, not effort-level.
          supportsReasoningControls: modelReasoningLevels.length > 0,
          // Provider-native option values that survive both the
          // Tab C per-model narrowing AND the model's capability
          // surface. NOT the narrow `ReasoningLevel` enum.
          allowedReasoningLevels: modelReasoningLevels,
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

    // Walk the two-rung chain at the CALL level. At most two
    // attempts: the configured primary, then the configured
    // fallback (if any). No third attempt, no deterministic default
    // rung, no OpenAI default. The Chat UI exposes exactly two
    // recommender controls ("Recommender engine" + "Fallback
    // engine (one)") and the backend must mirror that mental model
    // exactly.
    for (const rung of chain) {
      const resolved = resolveModel(rung.modelId);
      if (!resolved.ok) {
        // Hard resolve failure (fabricated id, access policy
        // denied, etc.). Record the rung as failed and stop —
        // never try a third "default" model.
        callAttempts.push({
          source: rung.source,
          modelId: rung.modelId,
          reasoning: rung.reasoningLevel ?? "",
          status: "failed",
          reason: `resolve_failed:${resolved.error.kind}`,
        });
        // eslint-disable-next-line no-console
        console.error("[model/recommend] rung failed to resolve", {
          source: rung.source,
          modelId: rung.modelId,
          reason: resolved.error.kind,
        });
        continue;
      }
      const resolvedForCall = resolved.resolved;
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

      let value: RecommenderOutput | null = null;
      let callFailureReason: string | null = null;
      try {
        value =
          resolvedForCall.providerId === "codex"
            ? await runCodexRecommender({
                modelId: resolvedForCall.modelId,
                system: prompt.system,
                user: prompt.user,
              })
            : (
                await generateText({
                  model: getRuntimeModel(resolvedForCall),
                  system: prompt.system,
                  prompt: prompt.user,
                  output: Output.object({
                    schema: outputSchema,
                    name: "normal_chat_model_recommendation",
                  }),
                  stopWhen: stepCountIs(1),
                  ...(rungProviderOptions ? { providerOptions: rungProviderOptions } : {}),
                })
              ).output;
      } catch (callErr) {
        // Caller-level failure for this rung (Codex CLI crashed,
        // AI SDK threw, etc.). Record the failure and stop — the
        // product contract is "primary → one fallback → blocked",
        // so we never walk a third default rung after this.
        callFailureReason = callErr instanceof Error ? callErr.message : String(callErr);
        // eslint-disable-next-line no-console
        console.error("[model/recommend] rung failed", {
          source: rung.source,
          modelId: rung.modelId,
          reason: callFailureReason,
        });
      }

      if (callFailureReason !== null) {
        callAttempts.push({
          source: rung.source,
          modelId: rung.modelId,
          reasoning: rung.reasoningLevel ?? "",
          status: "failed",
          reason: callFailureReason,
        });
        continue;
      }

      if (!value) {
        callAttempts.push({
          source: rung.source,
          modelId: rung.modelId,
          reasoning: rung.reasoningLevel ?? "",
          status: "failed",
          reason: "empty_recommendation_output",
        });
        continue;
      }

      const picked = availableModels.find(
        (m) => m.modelId === value!.recommendedModelId && m.provider === value!.recommendedProvider,
      );
      if (!picked) {
        callAttempts.push({
          source: rung.source,
          modelId: rung.modelId,
          reasoning: rung.reasoningLevel ?? "",
          status: "failed",
          reason: "invalid_recommendation",
        });
        continue;
      }
      const level = picked.supportsReasoningControls ? value.recommendedReasoningLevel : null;
      if (level && !picked.allowedReasoningLevels.includes(level)) {
        callAttempts.push({
          source: rung.source,
          modelId: rung.modelId,
          reasoning: rung.reasoningLevel ?? "",
          status: "failed",
          reason: "invalid_reasoning_level",
        });
        continue;
      }

      // Success on this rung. Record the success and return the
      // recommendation. We do NOT walk any further rungs.
      attemptedCandidateModel = value.recommendedModelId;
      callAttempts.push({
        source: rung.source,
        modelId: rung.modelId,
        reasoning: rung.reasoningLevel ?? "",
        status: "success",
        reason: "ok",
      });
      recommenderSource = rung.source;
      recommenderResolutionReason =
        rung.source === "configured_fallback"
          ? "Using the user-configured recommender fallback (primary engine unavailable)."
          : "Using the configured recommender engine.";
      return Response.json({
        ...value,
        recommendedReasoningLevel: level,
        alternatives: value.alternatives?.filter((a) =>
          availableModels.some((m) => m.modelId === a.modelId && m.provider === a.provider),
        ),
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

    const policy = enforceNoApiBillingFallback({
      requested: {
        modelId: input.currentModelId ?? "gpt-5.4-mini",
        providerId: (input.currentProvider ?? "openai") as "openai" | "minimax" | "codex",
        billingSource:
          (input.currentProvider ?? "openai") === "openai" ? "api_billing" : "subscription",
        selectionSource: "user_accepted",
      },
      kind: "recommender_runner_failed",
      reason:
        "The recommender runner could not produce a recommendation. Control Room will not silently switch to an API-billed model.",
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
        {
          modelId: "codex:gpt-5.4-mini",
          displayLabel: "Codex · GPT-5.4 Mini · Codex subscription",
        },
        { modelId: "MiniMax-M3", displayLabel: "MiniMax-M3 · MiniMax subscription" },
      ],
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
      ? providerIdFromModelIdForChain(lastAttempt.modelId)
      : "codex";
    const response = fallbackResponse(
      input,
      {
        provider: activeProvider,
        modelId:
          lastAttempt?.modelId ?? settings.normalChatRecommenderModelId ?? "codex:gpt-5.4-mini",
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
    return Response.json({
      ...response,
      proposedSubscriptionFallbacks: proposals,
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
