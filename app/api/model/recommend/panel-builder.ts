import "server-only";

/**
 * Pure helper that builds the new `RoutingDecisionPanel` wire
 * payload from a successful model-pick recommender result.
 *
 * The route (`app/api/model/recommend/route.ts`) calls this
 * helper after `walkRecommenderChain` returns success. The
 * helper is a pure function — no I/O — so the unit tests in
 * `panel-builder.test.ts` exercise every behavioral path
 * without spinning up Next.js.
 *
 * Hard rules (from the brief):
 *   - ROUTER and ROUTER fallback model ids are NEVER execution
 *     models. `assertNotRouterModel` throws a tagged error if
 *     the recommender's pick or alternatives contains a
 *     recommender-chain id.
 *   - The execution package explanation is ONE string — not a
 *     concatenation of per-field explanations.
 *   - The context decision and the execution package carry
 *     SEPARATE explanations so the UI can render two distinct
 *     "why" lines.
 *   - "GPT-5.5 low reasoning" internal representation stays
 *     `model: "codex:gpt-5.5", reasoningLevel: "low"` (verbatim
 *     provider-native string).
 */

import type {
  PanelHarness,
  RoutingDecisionPanel,
  RoutingDecisionPanelPackage,
} from "@/lib/router/routing-decision-panel-types";
import { assertPanelShape } from "@/lib/router/recommendation-shape";
import {
  derivePanelConfidence,
  estimatePanelCostTier,
} from "@/lib/router/recommendation-shape";
import type { EffectiveRegistry } from "@/lib/providers/registry";

/**
 * The minimal recommender-output shape consumed by the panel
 * builder. Matches the zod `outputSchema` in `route.ts` and the
 * type the chain walker returns. The builder accepts a subset
 * so unit tests can pass a plain object.
 */
export type PanelBuilderRecommenderValue = {
  recommendedModelId: string;
  recommendedProvider: string;
  recommendedReasoningLevel: string | null;
  reasoning: string;
  alternatives?: ReadonlyArray<{
    modelId: string;
    provider: string;
    recommendedReasoningLevel: string | null;
    reason: string;
  }>;
};

export type PanelBuilderContextDecision = {
  decision: "chat_only" | "harness_needed";
  explanation: string;
};

/**
 * Tag the "router model treated as execution" violation so the
 * route can surface it as a loud 500 with a clear error type.
 * The brief: "ROUTER models must never be treated as execution
 * models."
 */
export class RouterModelTreatedAsExecutionError extends Error {
  readonly offendingModelId: string;
  constructor(modelId: string) {
    super(`Router model id "${modelId}" was treated as an execution model — this is forbidden.`);
    this.name = "RouterModelTreatedAsExecutionError";
    this.offendingModelId = modelId;
  }
}

/**
 * The harness heuristic. The brief does not ask for a per-harness
 * picker in the panel — the second-stage
 * `codingHarnessRecommendation` flow (unchanged) handles Codex
 * CLI vs MiniMax CLI at send time. The panel therefore maps:
 *
 *   - Any Codex-catalog recommended model whose
 *     `supportedExecutionTargets` includes `"codex_cli"` →
 *     `repo_file_harness`.
 *   - Anything else (including pure chat-model picks) →
 *     `normal_chat`.
 *
 * The two alternatives are always `[normal_chat, repo_file_harness]`
 * so the user can switch from one to the other.
 */
function pickHarnessRecommendation(args: {
  recommendedModelId: string;
  registry: EffectiveRegistry | null;
}): PanelHarness {
  if (!args.registry) return "normal_chat";
  const entry = args.registry.models.find((m) => m.modelId === args.recommendedModelId);
  if (!entry) return "normal_chat";
  const targets = entry.supportedExecutionTargets ?? [];
  if (targets.includes("codex_cli") || targets.includes("minimax_cli")) {
    return "repo_file_harness";
  }
  return "normal_chat";
}

/**
 * Append a harness hint sentence when the panel recommends
 * `repo_file_harness`. The brief allows the package explanation
 * to include a harness hint so the user understands why a
 * non-default harness was chosen.
 */
function appendHarnessHint(explanation: string, harness: PanelHarness): string {
  if (harness === "normal_chat") return explanation;
  return `${explanation} Routes through the repo/file harness so the model can read or change project files.`;
}

/**
 * Build the new panel payload from the recommender's result
 * + the classifier's context decision + the live registry.
 *
 * Throws `RouterModelTreatedAsExecutionError` if the recommender
 * pick or any alternative is a configured recommender-chain id.
 * Throws `PanelShapeError` (via `assertPanelShape`) on any other
 * shape regression so a future refactor cannot silently emit a
 * malformed panel.
 */
export function buildPanelFromRecommenderValue(args: {
  recommenderValue: PanelBuilderRecommenderValue;
  contextDecision: PanelBuilderContextDecision;
  /**
   * Provider-native reasoning level the recommender picked.
   * `null` means "model does not support reasoning controls";
   * the helper maps that to the panel's `"none"` sentinel.
   */
  level: string | null;
  registry: EffectiveRegistry | null;
  executionBlocklist: ReadonlyArray<string>;
  registryToAllowedReasoningValues: (modelId: string) => ReadonlyArray<string>;
  latencyMs: number;
}): RoutingDecisionPanel {
  const blocklist = new Set(args.executionBlocklist);
  if (blocklist.has(args.recommenderValue.recommendedModelId)) {
    throw new RouterModelTreatedAsExecutionError(args.recommenderValue.recommendedModelId);
  }

  // Strip the blocklist from the wire-shape alternatives silently
  // — the primary pick is the model that will actually run, and a
  // ROUTER id there is a hard violation. Alternatives are
  // suggestions only (the panel UI shows them in a dropdown);
  // silently dropping them is safer than throwing, because the
  // user has not yet picked them and a thrown error would hide a
  // valid recommendation behind a router-id leak.
  const alternatives = (args.recommenderValue.alternatives ?? [])
    .map((a) => a.modelId)
    .filter((id) => !blocklist.has(id));

  const supportedValues = args.registryToAllowedReasoningValues(
    args.recommenderValue.recommendedModelId,
  );
  // `"none"` is the panel sentinel for "no reasoning controls".
  // When the model doesn't support reasoning controls, the
  // supportedValues list is empty and the recommended value is
  // `"none"`.
  const reasoningRecommended =
    supportedValues.length === 0
      ? "none"
      : args.level && supportedValues.includes(args.level)
        ? args.level
        : (supportedValues[0] ?? "none");

  const harness: PanelHarness = pickHarnessRecommendation({
    recommendedModelId: args.recommenderValue.recommendedModelId,
    registry: args.registry,
  });

  const executionPackage: RoutingDecisionPanelPackage = {
    model: {
      recommended: args.recommenderValue.recommendedModelId,
      alternatives,
    },
    reasoningLevel: {
      recommended: reasoningRecommended,
      supportedValues,
    },
    harness: {
      recommended: harness,
      alternatives: ["normal_chat", "repo_file_harness"],
    },
    explanation: appendHarnessHint(args.recommenderValue.reasoning, harness),
  };

  const panel: RoutingDecisionPanel = {
    contextDecision: {
      recommended: args.contextDecision.decision,
      explanation: args.contextDecision.explanation,
    },
    executionPackage,
    confidence: derivePanelConfidence({
      reasoningLevel: reasoningRecommended,
      reasoningSupportedValues: supportedValues,
    }),
    costTier: estimatePanelCostTier(args.recommenderValue.recommendedModelId, args.registry),
    latencyMs: Math.max(0, args.latencyMs),
  };

  assertPanelShape(panel);
  return panel;
}

/**
 * Build the panel payload for the loud-failure path (no
 * recommender rung succeeded). The brief: "do NOT auto-substitute
 * a different model — the user's current selection is preserved,
 * and `proposedSubscriptionFallbacks` carries the only acceptable
 * alternatives." The panel therefore surfaces a `chat_only`
 * default and the user's current manual selection as the
 * execution model — never a third hidden Codex / MiniMax default
 * rung.
 */
export function buildPanelForLoudFailure(args: {
  contextExplanation: string;
  currentModelId: string;
  currentReasoningLevel: string | null;
  registry: EffectiveRegistry | null;
  latencyMs: number;
}): RoutingDecisionPanel {
  const supportedValues = args.registry
    ? args.registry.models.find((m) => m.modelId === args.currentModelId)
      ? deriveSupportedReasoningValues({
          modelId: args.currentModelId,
          registry: args.registry,
        })
      : []
    : [];

  const reasoningRecommended =
    supportedValues.length === 0
      ? "none"
      : args.currentReasoningLevel && supportedValues.includes(args.currentReasoningLevel)
        ? args.currentReasoningLevel
        : (supportedValues[0] ?? "none");

  const harness: PanelHarness = pickHarnessRecommendation({
    recommendedModelId: args.currentModelId,
    registry: args.registry,
  });

  const panel: RoutingDecisionPanel = {
    contextDecision: {
      recommended: "chat_only",
      explanation:
        args.contextExplanation ||
        "Recommender unavailable; defaulting to chat-only context so the user's manual selection is preserved.",
    },
    executionPackage: {
      model: {
        recommended: args.currentModelId,
        alternatives: [],
      },
      reasoningLevel: {
        recommended: reasoningRecommended,
        supportedValues,
      },
      harness: {
        recommended: harness,
        alternatives: ["normal_chat", "repo_file_harness"],
      },
      explanation:
        "Recommender could not run. Control Room will not auto-substitute a different model; the user's manual selection is preserved. Switch the model dropdown or click Send default to proceed without routing.",
    },
    confidence: 0,
    costTier: estimatePanelCostTier(args.currentModelId, args.registry),
    latencyMs: Math.max(0, args.latencyMs),
  };
  assertPanelShape(panel);
  return panel;
}

/**
 * Local helper for the loud-failure path that derives the
 * supported reasoning values for a model from the registry.
 * Inlined here (not exported) to keep the panel builder
 * self-contained; the route uses its own equivalent that
 * intersects with `allowedCombos`.
 */
function deriveSupportedReasoningValues(args: {
  modelId: string;
  registry: EffectiveRegistry;
}): ReadonlyArray<string> {
  const entry = args.registry.models.find((m) => m.modelId === args.modelId);
  if (!entry) return [];
  if (!entry.supportsReasoningLevels) return [];
  return entry.supportedReasoningLevels;
}