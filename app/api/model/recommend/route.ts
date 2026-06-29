import "server-only";

import { generateText, Output, stepCountIs } from "ai";
import { z } from "zod/v4";
import { getEffectiveModelsResponse } from "@/lib/providers/registry";
import { getModelMeta, resolveModel } from "@/lib/providers";
import type { ResolvedModel } from "@/lib/providers/types";
import { getRuntimeModel, getRuntimeProviderOptions } from "@/lib/providers/runtime";
import { getEffectiveRouterSettings } from "@/lib/router/settings-store";
import { buildRouterFallbackChain } from "@/lib/router/schema";
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
    recommenderSource:
      | "configured"
      | "configured_fallback"
      | "codex"
      | "minimax"
      | "openai"
      | "fallback"
      | null;
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
    /**
     * Per-rung call-attempt trace. Records every recommender rung
     * the route actually called, with the failure reason for any
     * rung that did not produce a parseable recommendation. Lets
     * the chat composer render diagnostics like
     * "primary recommender failed: codex:gpt-5.4-mini · low ·
     * usage_limit; configured fallback tried: MiniMax-M3 ·
     * provider_default" exactly as the brief asks.
     */
    callAttempts?: ReadonlyArray<{ providerId: string; modelId: string; reason: string }>;
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

function fallbackResponse(
  input: z.infer<typeof bodySchema>,
  recommender: { provider: string; modelId: string },
  attemptedCandidateModel: string | null,
  chain: ReadonlyArray<{ providerId: string; modelId: string }> = [],
  source:
    | "configured"
    | "configured_fallback"
    | "codex"
    | "minimax"
    | "openai"
    | "fallback" = "fallback",
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
    reasoning:
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
  // position 2 — right after the configured primary, before the
  // deterministic Codex → MiniMax → OpenAI API defaults. When set,
  // the runtime uses `normalChatRecommenderFallbackReasoningLevel`
  // instead of `normalChatRecommenderReasoningLevel` when the
  // fallback is the active recommender.
  const chain = buildRouterFallbackChain({
    configuredRouterModelId: settings.normalChatRecommenderModelId,
    configuredRouterFallbackModelId: settings.normalChatRecommenderFallbackModelId,
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
  // closure-assigned variable, but the call-site consumes
  // `resolvedForCall` directly, so we do not need a separate outer
  // `resolvedActiveRecommender` here.
  let recommenderSource:
    | "configured"
    | "configured_fallback"
    | "codex"
    | "minimax"
    | "openai"
    | "fallback" = "fallback";
  let recommenderResolutionReason = "All candidates failed.";
  // When the active recommender is the user-configured fallback, we
  // use the fallback reasoning level instead of the primary one. The
  // resolver below records the active rung; the recommender call site
  // reads it to pick the right level.
  let activeRungIsUserFallback = false;
  // Per-rung call-attempt trace. Populated as the route walks the
  // chain at the call level; surfaced in the response `diagnostics`
  // so the chat composer can render "primary recommender failed: …
  // usage_limit; configured fallback tried: …" exactly as the brief
  // asks. Declared in the outer scope so the catch block can also
  // include it in the loud-failure response.
  let callAttempts: Array<{
    candidate: { providerId: "openai" | "codex" | "minimax"; modelId: string };
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
          chain.map((c) => ({ providerId: c.providerId, modelId: c.modelId })),
          recommenderSource,
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

    // Walk the chain at the CALL level too. The previous revision of
    // this route only walked the chain at the resolution level
    // (`pickRouterModelForRun`), which means a primary recommender
    // (e.g. Codex) that resolved OK but failed at runtime (e.g.
    // "usage limit") short-circuited straight to the catch block and
    // never tried the user-configured fallback (e.g. MiniMax-M3).
    // The brief is explicit: "If Codex fails because of usage
    // limit/quota: try the configured fallback recommender engine".
    //
    // The walk is bounded to the first candidate that both
    // (a) resolves to a runtime-invokable shape AND
    // (b) returns a parseable recommendation from the provider call.
    // We deliberately do NOT add an automatic retry of the same
    // candidate — usage-limit / quota errors are deterministic per
    // session, and the user-configured fallback is the explicit
    // policy-level answer.
    // (Note: `callAttempts` is declared in the outer scope so the
    // catch block can also include it in the loud-failure response.)
    for (const candidate of chain) {
      if (candidate.providerId === "openai" && !settings.allowOpenAiApiRouter) {
        // Defense-in-depth: skip OpenAI API candidates when the
        // opt-in is off, even if they made it into the chain.
        callAttempts.push({
          candidate,
          reason: "openai_api_opt_in_disabled",
        });
        continue;
      }
      const resolved = resolveModel(candidate.modelId);
      if (!resolved.ok) {
        callAttempts.push({
          candidate,
          reason: `resolve_failed:${resolved.error.kind}`,
        });
        continue;
      }
      const resolvedForCall = resolved.resolved;
      // Track this rung as the active recommender for diagnostics.
      // We update diagnostics for each rung so the final response
      // reflects the rung that actually answered.
      activeRecommender = {
        provider: candidate.providerId,
        modelId: candidate.modelId,
      };
      activeRungIsUserFallback = Boolean(candidate.isUserConfiguredFallback);
      // Pick the reasoning level for this specific rung.
      const rungReasoningLevel: string | undefined = activeRungIsUserFallback
        ? (settings.normalChatRecommenderFallbackReasoningLevel ?? undefined)
        : settings.normalChatRecommenderReasoningLevel;
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
        // Caller-level failure for this rung (Codex CLI crashed, AI
        // SDK threw, etc.). The brief: "If Codex fails because of
        // usage limit/quota: try the configured fallback
        // recommender engine." — so we record the failure and
        // continue to the next rung.
        const reason = callErr instanceof Error ? callErr.message : String(callErr);
        callAttempts.push({ candidate, reason });
        // Keep the resolved candidate in sync for the
        // diagnostics block so the failure response can name the
        // rung we just tried. (`resolvedForCall` is consumed
        // directly below; this comment is just for the next rung's
        // `continue` to find a stable reference.)
        recommenderSource = activeRungIsUserFallback
          ? "configured_fallback"
          : candidate.providerId === "codex"
            ? "codex"
            : candidate.providerId === "minimax"
              ? "minimax"
              : "openai";
        recommenderResolutionReason = `Recommender rung ${candidate.modelId} (${candidate.providerId}) failed: ${reason}. Trying the next rung.`;
        // eslint-disable-next-line no-console
        console.error("[model/recommend] rung failed, trying next", {
          candidate: `${candidate.providerId}:${candidate.modelId}`,
          reason,
        });
        continue;
      }

      if (!value) {
        callAttempts.push({
          candidate,
          reason: "empty_recommendation_output",
        });
        continue;
      }
      attemptedCandidateModel = value.recommendedModelId;
      const picked = availableModels.find(
        (m) => m.modelId === value!.recommendedModelId && m.provider === value!.recommendedProvider,
      );
      if (!picked) {
        callAttempts.push({ candidate, reason: "invalid_recommendation" });
        continue;
      }
      const level = picked.supportsReasoningControls ? value.recommendedReasoningLevel : null;
      if (level && !picked.allowedReasoningLevels.includes(level)) {
        callAttempts.push({ candidate, reason: "invalid_reasoning_level" });
        continue;
      }
      // Success. Stash the resolved candidate for the response and
      // pick a source label that matches the brief's `configured` /
      // `configured_fallback` / provider taxonomy.
      recommenderSource = activeRungIsUserFallback
        ? "configured_fallback"
        : candidate.providerId === "codex"
          ? "codex"
          : candidate.providerId === "minimax"
            ? "minimax"
            : "openai";
      recommenderResolutionReason = activeRungIsUserFallback
        ? "Using the user-configured recommender fallback (primary engine unavailable)."
        : candidate.providerId === "codex"
          ? "Using a Codex subscription router model."
          : candidate.providerId === "minimax"
            ? "Using the MiniMax M3 subscription fallback (Codex unavailable)."
            : "Using the explicitly enabled OpenAI API router model.";
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
          callAttempts: callAttempts.map((a) => ({
            providerId: a.candidate.providerId,
            modelId: a.candidate.modelId,
            reason: a.reason,
          })),
        },
      } satisfies RecommendationResponse);
    }

    // No rung succeeded. Fall through to the loud-failure response.
    // Surface the last rung's failure so the user can see which
    // candidate failed.
    const lastAttempt = callAttempts[callAttempts.length - 1];
    throw new Error(
      lastAttempt
        ? `All recommender rungs failed. Last: ${lastAttempt.candidate.modelId} (${lastAttempt.candidate.providerId}): ${lastAttempt.reason}.`
        : "All recommender rungs failed.",
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
      diagnostics: {
        ...response.diagnostics,
        callAttempts: callAttempts.map((a) => ({
          providerId: a.candidate.providerId,
          modelId: a.candidate.modelId,
          reason: a.reason,
        })),
      },
    } satisfies RecommendationResponse);
  }
}
