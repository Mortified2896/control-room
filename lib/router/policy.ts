/**
 * Router policy — pure functions.
 *
 * No I/O, no env reads, no model calls. Everything in here is deterministic
 * and unit-testable. The router graph (lib/router/graph.ts) and the chat
 * route both consume these functions to decide what Side B is allowed to be.
 *
 * Hard rules from the brief (encoded here):
 *   1. The router must never choose from every model that is technically
 *      available. It may only choose from the explicit allowlist exported
 *      by `lib/providers/listRouterAllowedPool(allowExpensive)`, further
 *      intersected with the user-curated `settings.allowedCombos`.
 *   2. Expensive model + high reasoning must never be recommended unless
 *      `allowExpensiveModels` is true.
 *   3. Long prompts must automatically exclude expensive model/reasoning
 *      combos unless `allowLongPromptWhenExpensive` is also true.
 *   4. If the estimated A/B cost exceeds `maxCostPerAbRunUsd`, do not run
 *      Side B. Show Side A only and log the skipped reason.
 *   5. If the router recommendation itself would exceed
 *      `maxCostPerRecommendationUsd`, fall back safely.
 *   6. If the router output is invalid (disallowed model or reasoning level,
 *      confidence out of range, etc.), reject it, use fallback, log.
 */
import type { RouterSettings } from "@/lib/router/schema";
import type { ReasoningLevel, RouterAllowlistEntry } from "@/lib/providers/types";
import { getModelMeta, listRouterAllowedPool } from "@/lib/providers";

export type RouterSideCombo = {
  modelId: string;
  reasoningLevel: ReasoningLevel;
};

/**
 * Per-(modelId, reasoningLevel) cost estimate in USD. Conservative placeholders
 * for the MVP — the brief explicitly accepts that cost numbers can be
 * placeholder-ish. One place to update later when real pricing lands.
 *
 * Numbers are intentionally low (the cheapest tier) so the budget guard
 * rejects expensive picks by default. Treat this table as "estimate only".
 */
const COST_TABLE_USD: Record<string, Record<ReasoningLevel, number>> = {
  "gpt-5.4-mini": { low: 0.001, medium: 0.003, high: 0.005 },
  "gpt-5.5": { low: 0.01, medium: 0.03, high: 0.06 },
};

function costOf(combo: RouterSideCombo): number {
  const row = COST_TABLE_USD[combo.modelId];
  if (!row) return 0;
  return row[combo.reasoningLevel] ?? 0;
}

export function estimateCostUsd(combo: RouterSideCombo): number {
  return costOf(combo);
}

/**
 * Compute the effective router allowlist for a single run.
 *
 * Inputs:
 *   - `settings.allowExpensiveModels` — when false, expensive-tier entries
 *     are excluded.
 *   - `settings.allowLongPromptWhenExpensive` — when false, expensive-tier
 *     entries are also excluded if `recentChars >= settings.longPromptThresholdChars`.
 *   - `settings.allowedCombos` — explicit (modelId, reasoningLevel) pairs
 *     the user has authorized. The runtime pool is the intersection of
 *     this list, the tier-filtered registry pool, and (for long prompts)
 *     the expensive auto-exclusion rule.
 *   - `recentChars` — approximate size of the user prompt + recent context
 *     in characters. The chat route computes this.
 *
 * Output: the (modelId, reasoningLevel) pairs the router may pick from.
 *
 * The intersection is performed in this order:
 *   1. Apply the registry tier filter (allowExpensiveModels).
 *   2. Intersect with the user's explicit allowlist (allowedCombos).
 *   3. If the prompt is long and the user has not opted in to expensive
 *      models on long prompts, drop any remaining expensive entries.
 */
export function resolveAllowedPool(
  settings: RouterSettings,
  recentChars: number,
): ReadonlyArray<RouterAllowlistEntry> {
  const base = listRouterAllowedPool(settings.allowExpensiveModels);
  const allowedKey = new Set(settings.allowedCombos.map((c) => `${c.modelId}|${c.reasoningLevel}`));
  const intersected = base.filter((entry) =>
    allowedKey.has(`${entry.modelId}|${entry.reasoningLevel}`),
  );
  const isLong = recentChars >= settings.longPromptThresholdChars;
  if (isLong && !settings.allowLongPromptWhenExpensive) {
    return intersected.filter((entry) => entry.tier !== "expensive");
  }
  return intersected;
}

/**
 * Membership test against the resolved allowlist.
 */
export function isInAllowedPool(
  combo: RouterSideCombo,
  pool: ReadonlyArray<RouterAllowlistEntry>,
): boolean {
  return pool.some(
    (entry) => entry.modelId === combo.modelId && entry.reasoningLevel === combo.reasoningLevel,
  );
}

/**
 * Validated router recommendation shape — what `validateRouterOutput` returns.
 * Matches the brief's required schema (model id + reasoning level + confidence
 * + task_type + short reason).
 */
export type RouterRecommendation = {
  recommendedModel: string;
  recommendedReasoningLevel: ReasoningLevel;
  confidence: number;
  taskType: RouterTaskType;
  shortReason: string;
};

export const ROUTER_TASK_TYPES = [
  "simple_chat",
  "coding",
  "debugging",
  "writing",
  "research",
  "analysis",
  "planning",
  "other",
] as const;
export type RouterTaskType = (typeof ROUTER_TASK_TYPES)[number];

/**
 * Internal raw shape coming out of the LLM. Field names mirror the prompt
 * the LLM is asked to emit; we translate to camelCase at the validation
 * boundary so callers don't have to deal with snake_case.
 */
export type RawRouterRecommendation = {
  recommended_model?: unknown;
  recommended_reasoning_level?: unknown;
  confidence?: unknown;
  task_type?: unknown;
  short_reason?: unknown;
};

export type RouterValidationResult =
  | { ok: true; value: RouterRecommendation }
  | { ok: false; reason: string };

const REASONING_LEVELS: ReadonlyArray<ReasoningLevel> = ["low", "medium", "high"];

/**
 * Validate an LLM-produced recommendation against the resolved allowlist.
 *
 * Rejects (with a precise reason) if:
 *   - any required field is missing or the wrong type,
 *   - the model id is not in the allowlist,
 *   - the reasoning level is not allowed for that model,
 *   - confidence is not a number in [0, 1],
 *   - task_type is not one of the recognized values,
 *   - short_reason is empty or absurdly long.
 *
 * The reason returned in the failure case is what the chat route logs and
 * shows in the UI's "Bad router choice" feedback context.
 */
export function validateRouterOutput(
  raw: unknown,
  pool: ReadonlyArray<RouterAllowlistEntry>,
): RouterValidationResult {
  if (raw == null || typeof raw !== "object") {
    return { ok: false, reason: "router output was not an object" };
  }
  const r = raw as RawRouterRecommendation;

  if (typeof r.recommended_model !== "string" || r.recommended_model.trim().length === 0) {
    return { ok: false, reason: "missing or invalid recommended_model" };
  }
  const modelId = r.recommended_model.trim();

  if (typeof r.recommended_reasoning_level !== "string") {
    return { ok: false, reason: "missing recommended_reasoning_level" };
  }
  const level = r.recommended_reasoning_level;
  if (!(REASONING_LEVELS as ReadonlyArray<string>).includes(level)) {
    return { ok: false, reason: `disallowed reasoning_level: ${String(level)}` };
  }
  const reasoningLevel = level as ReasoningLevel;

  if (typeof r.confidence !== "number" || !Number.isFinite(r.confidence)) {
    return { ok: false, reason: "confidence must be a finite number" };
  }
  if (r.confidence < 0 || r.confidence > 1) {
    return { ok: false, reason: "confidence must be between 0 and 1" };
  }

  if (typeof r.task_type !== "string") {
    return { ok: false, reason: "missing task_type" };
  }
  if (!(ROUTER_TASK_TYPES as ReadonlyArray<string>).includes(r.task_type)) {
    return { ok: false, reason: `disallowed task_type: ${r.task_type}` };
  }
  const taskType = r.task_type as RouterTaskType;

  if (typeof r.short_reason !== "string" || r.short_reason.trim().length === 0) {
    return { ok: false, reason: "short_reason must be a non-empty string" };
  }
  if (r.short_reason.length > 240) {
    return { ok: false, reason: "short_reason exceeds 240 chars" };
  }

  // Membership in the allowlist is the final, strictest check.
  const combo: RouterSideCombo = { modelId, reasoningLevel };
  if (!isInAllowedPool(combo, pool)) {
    return { ok: false, reason: `combo not in allowlist: ${modelId} / ${reasoningLevel}` };
  }
  // Also reject if the model itself is not in the provider registry — the
  // allowlist is sourced from the registry, so this is a belt-and-braces check.
  const meta = getModelMeta(modelId);
  if (!meta) {
    return { ok: false, reason: `unknown model id: ${modelId}` };
  }
  if (!(meta.reasoningLevels as ReadonlyArray<string>).includes(reasoningLevel)) {
    return { ok: false, reason: `reasoning level not supported by model: ${reasoningLevel}` };
  }

  return {
    ok: true,
    value: {
      recommendedModel: modelId,
      recommendedReasoningLevel: reasoningLevel,
      confidence: r.confidence,
      taskType,
      shortReason: r.short_reason.trim(),
    },
  };
}

/**
 * Deterministic fallback picker — used when the router fails, returns
 * invalid output, or its recommendation would exceed the recommendation
 * budget. Picks the cheapest combo in the allowlist, breaking ties on
 * modelId then reasoningLevel for stability across runs.
 */
export function pickFallback(pool: ReadonlyArray<RouterAllowlistEntry>): RouterSideCombo {
  if (pool.length === 0) {
    // Last-ditch default — must be in the registry or nothing works.
    return { modelId: "gpt-5.4-mini", reasoningLevel: "low" };
  }
  const sorted = [...pool].sort((a, b) => {
    const costA = costOf({ modelId: a.modelId, reasoningLevel: a.reasoningLevel });
    const costB = costOf({ modelId: b.modelId, reasoningLevel: b.reasoningLevel });
    if (costA !== costB) return costA - costB;
    if (a.modelId !== b.modelId) return a.modelId.localeCompare(b.modelId);
    return a.reasoningLevel.localeCompare(b.reasoningLevel);
  });
  const first = sorted[0];
  return { modelId: first.modelId, reasoningLevel: first.reasoningLevel };
}

export type BudgetDecision =
  | { keepB: true; combo: RouterSideCombo; estimatedCostUsd: number }
  | { keepB: false; reason: string; estimatedCostUsd: number };

/**
 * Decide whether Side B should actually run, given Side A's combo, the
 * recommended combo, the settings, and the size of the prompt.
 *
 * - If the recommendation itself exceeds `maxCostPerRecommendationUsd`,
 *   skip B and report "router recommendation exceeded budget".
 * - If Side A + Side B combined exceed `maxCostPerAbRunUsd`, skip B and
 *   report "A/B cost exceeded max-cost-per-run".
 * - Long-prompt + expensive is also rejected here as a defense-in-depth
 *   even though the allowlist already excludes it.
 */
export function applyBudgetGuard(
  sideA: RouterSideCombo,
  sideB: RouterSideCombo,
  settings: RouterSettings,
  recentChars: number,
): BudgetDecision {
  const sideBCost = costOf(sideB);
  if (sideBCost > settings.maxCostPerRecommendationUsd) {
    return {
      keepB: false,
      reason: `router recommendation cost $${sideBCost.toFixed(4)} exceeds max $${settings.maxCostPerRecommendationUsd.toFixed(4)}`,
      estimatedCostUsd: sideBCost,
    };
  }
  const totalCost = costOf(sideA) + sideBCost;
  if (totalCost > settings.maxCostPerAbRunUsd) {
    return {
      keepB: false,
      reason: `A/B cost $${totalCost.toFixed(4)} exceeds max $${settings.maxCostPerAbRunUsd.toFixed(4)}`,
      estimatedCostUsd: totalCost,
    };
  }
  // Defense in depth: a long prompt that somehow snuck an expensive combo
  // through the allowlist should still be rejected. Cheap is fine either way.
  if (recentChars >= settings.longPromptThresholdChars && !settings.allowLongPromptWhenExpensive) {
    const meta = getModelMeta(sideB.modelId);
    if (meta?.tier === "expensive") {
      return {
        keepB: false,
        reason: "expensive model excluded for long prompt",
        estimatedCostUsd: totalCost,
      };
    }
  }
  return { keepB: true, combo: sideB, estimatedCostUsd: totalCost };
}
