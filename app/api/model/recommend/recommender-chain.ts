/**
 * Pure two-rung recommender chain walker.
 *
 * Extracted from `app/api/model/recommend/route.ts` so the brief's
 * product contract can be unit-tested without spinning up the full
 * Next.js request pipeline. The walker is the small but critical
 * loop that pins down the contract:
 *
 *   - Try the configured primary.
 *   - On failure, CONTINUE (not break) to the configured fallback.
 *   - Stop after at most 2 attempts — no Codex default, no MiniMax
 *     default, no OpenAI default, no hidden third "provider default"
 *     rung. The Chat UI exposes exactly two recommender controls
 *     ("Recommender engine" + "Fallback engine (one)") and the
 *     backend must mirror that mental model.
 *
 * The walker is intentionally pure: every side effect (HTTP request,
 * codex CLI invocation, AI SDK call) is injected as the `runRung`
 * callback so the test can substitute a deterministic stub. The
 * resolver is injected as `resolveModel` for the same reason — the
 * real `resolveModel` from `@/lib/providers` reads the OpenAI/MiniMax
 * registry at module load, which is fine in production but couples
 * this helper to that registry for unit tests.
 */

export type RecommenderChainRung = {
  /** Position in the chain. "configured" is the primary; "configured_fallback" is the second rung. */
  source: "configured" | "configured_fallback";
  providerId: "openai" | "codex" | "minimax";
  modelId: string;
  /** Provider-native reasoning value picked by the user for this rung (e.g. "low", "xhigh"). */
  reasoningLevel: string | undefined;
};

export type RecommenderCallAttempt = {
  source: "configured" | "configured_fallback";
  modelId: string;
  /** Mirrors `rung.reasoningLevel` at the time of the attempt; empty string when undefined. */
  reasoning: string;
  status: "success" | "failed";
  /** Stable string the route + chat composer surface in diagnostics. */
  reason: string;
};

/**
 * The structured-output shape the recommender returns. Mirrors
 * `outputSchema` in `route.ts` but stated as a pure type so the
 * helper doesn't need to depend on the route's zod schema.
 */
export type RecommenderOutputShape = {
  recommendedModelId: string;
  recommendedProvider: string;
  /** Provider-native reasoning-effort value. Null when the model doesn't support controls. */
  recommendedReasoningLevel: string | null;
  reasoning: string;
  alternatives?: ReadonlyArray<{
    modelId: string;
    provider: string;
    recommendedReasoningLevel: string | null;
    reason: string;
  }>;
};

/**
 * Subset of `NormalChatAvailableModel` (from `lib/router/normal-chat-prompts.ts`)
 * that the chain walker needs for validation. Kept as a structural
 * type so the helper does not import the prompts module.
 */
export type RecommenderChainAvailableModel = {
  provider: string;
  modelId: string;
  /** When `false`, the recommender's reasoning-level pick is ignored and forced to null. */
  supportsReasoningControls: boolean;
  /** Provider-native reasoning values the model advertises. */
  allowedReasoningLevels: ReadonlyArray<string>;
};

export type ResolvedProvider = {
  providerId: "openai" | "codex" | "minimax";
  modelId: string;
  billingSource: "api_billing" | "subscription";
};

/**
 * Shape of `resolveModel` from `@/lib/providers`. The walker only
 * looks at `.ok` + `.error.kind` + `.resolved`, so any compatible
 * implementation works.
 */
export type ResolveFn = (
  modelId: string,
) => { ok: true; resolved: ResolvedProvider } | { ok: false; error: { kind: string } };

/**
 * The per-rung I/O callback. The walker calls this AFTER the rung
 * has resolved successfully. Returning a value yields a validation
 * step; throwing yields a "call failed" attempt + continue.
 */
export type RunRungArgs = {
  rung: RecommenderChainRung;
  resolved: ResolvedProvider;
};

export type RunRungFn = (args: RunRungArgs) => Promise<RecommenderOutputShape>;

export type RecommenderChainSuccess = {
  kind: "success";
  rung: RecommenderChainRung;
  resolved: ResolvedProvider;
  value: RecommenderOutputShape;
  /**
   * Provider-native reasoning-effort value the route should surface.
   * Derived from the recommendation's `recommendedReasoningLevel`
   * intersected with the picked model's `allowedReasoningLevels`,
   * coerced to `null` when the model does not support controls.
   */
  level: string | null;
  callAttempts: ReadonlyArray<RecommenderCallAttempt>;
};

export type RecommenderChainNoSuccess = {
  kind: "no_success";
  callAttempts: ReadonlyArray<RecommenderCallAttempt>;
};

export type RecommenderChainResult = RecommenderChainSuccess | RecommenderChainNoSuccess;

/**
 * Walk `chain` calling `resolveModel` + `runRung` for each candidate.
 *
 * Behavior contract (unit-tested in `recommender-chain.test.ts`):
 *
 *   1. On `resolveModel` failure the rung is recorded as failed and
 *      the loop CONTINUES — never `break`. The chain is exactly
 *      the configured rungs; no third default is appended.
 *   2. On `runRung` throw / empty output / invalid recommendation /
 *      invalid reasoning level the rung is recorded as failed and
 *      the loop CONTINUES. The chain walker is allowed to walk past
 *      disabled or invalid rungs without halting.
 *   3. The first successful rung wins. The walker does NOT try a
 *      third candidate even if more rungs were provided — the
 *      product contract caps the chain at two.
 *   4. The walker is pure: it returns the structured outcome
 *      (`success` or `no_success`) and the per-rung call-attempt
 *      trace. The route owns the response-shaping side.
 *
 * The `continue` semantics are explicit and load-bearing — the
 * unit test pins this so a future refactor that swaps `continue`
 * for `break` (or adds a third "default" rung) fails fast.
 */
export async function walkRecommenderChain(input: {
  chain: ReadonlyArray<RecommenderChainRung>;
  resolveModel: ResolveFn;
  runRung: RunRungFn;
  availableModels: ReadonlyArray<RecommenderChainAvailableModel>;
}): Promise<RecommenderChainResult> {
  const { chain, resolveModel, runRung, availableModels } = input;
  const callAttempts: RecommenderCallAttempt[] = [];

  for (const rung of chain) {
    const resolved = resolveModel(rung.modelId);
    if (!resolved.ok) {
      // Disabled / invalid / fabricated rung — skip with `continue`,
      // do NOT `break` the chain. The next rung (if any) is still
      // attempted. The chain walker never appends a hidden third
      // "default" rung.
      callAttempts.push({
        source: rung.source,
        modelId: rung.modelId,
        reasoning: rung.reasoningLevel ?? "",
        status: "failed",
        reason: `resolve_failed:${resolved.error.kind}`,
      });
      continue;
    }

    let value: RecommenderOutputShape | null = null;
    let callFailureReason: string | null = null;
    try {
      value = await runRung({ rung, resolved: resolved.resolved });
    } catch (callErr) {
      callFailureReason = callErr instanceof Error ? callErr.message : String(callErr);
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

    // Success on this rung. Record the success and stop — the chain
    // walker never tries a third rung after the configured fallback.
    callAttempts.push({
      source: rung.source,
      modelId: rung.modelId,
      reasoning: rung.reasoningLevel ?? "",
      status: "success",
      reason: "ok",
    });
    return {
      kind: "success",
      rung,
      resolved: resolved.resolved,
      value,
      level,
      callAttempts,
    };
  }

  return { kind: "no_success", callAttempts };
}
