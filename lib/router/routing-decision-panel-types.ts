/**
 * Routing Decision Panel — shared wire types.
 *
 * Single source of truth for the new compact editable panel that
 * replaces the previous step-by-step recommendation card. The
 * `/api/model/recommend` route emits this shape, the
 * `RoutingDecisionPanel` React component renders it, and the new
 * `routing_decision_panel_runs` telemetry table persists it.
 *
 * The brief is explicit that these enum values coexist with the
 * legacy `normal_chat | coding_task` enums during the additive
 * migration; the legacy route continues to return its own shape
 * until phase 6 (which is a follow-up after the panel is live).
 *
 * Hard rules (from AGENTS.md and the panel brief):
 *   - ROUTER and ROUTER fallback model ids are NEVER execution
 *     models. The panel builder (`panel-builder.ts`) and the
 *     `getExecutionEligibleModelIds` helper in `lib/router/schema.ts`
 *     enforce this at every layer.
 *   - The router only RECOMMENDS — it never silently overrides
 *     the user's selection. `computeChangedFields` here is the
 *     single source of truth for the diff so the chat route can
 *     persist "this came from the user, not the recommender".
 *   - "GPT-5.5 low reasoning" internal representation stays
 *     `model: "codex:gpt-5.5", reasoningLevel: "low"` — NOT a
 *     separate enum or a normalized form. The helpers below keep
 *     the provider-native reasoning value verbatim.
 */

import type { RouterSettings } from "@/lib/router/schema";
import type { EffectiveRegistry } from "@/lib/providers/registry";

/**
 * Context decision — the most important routing decision. Answers
 * "can this request be handled by normal chat, or does it need a
 * harness with repo/file/tool access?".
 *
 * `chat_only`     → the prompt is conversational / explanatory /
 *                   general knowledge. Normal chat is enough.
 * `harness_needed`→ the prompt references files, repos, env vars,
 *                   build failures, or asks to change the project.
 *                   A harness (Codex CLI, MiniMax CLI, …) is
 *                   required to inspect / edit the workspace.
 *
 * Crucially, `harness_needed` is NOT synonymous with "coding
 * task" — many non-coding prompts still need repo access. See the
 * brief for the example list.
 */
export type ContextDecision = "chat_only" | "harness_needed";

/**
 * Panel-side harness value. The UI exposes `Normal chat` /
 * `Repo/file harness`. The panel maps to the internal
 * `codex_cli` / `minimax_cli` harness id only at send time (the
 * brief: "may internally use the current coding-agent path if
 * that is the existing implementation, but the UI should call
 * it Repo/file harness").
 *
 * `normal_chat`        → chat route, no harness subprocess.
 * `repo_file_harness`  → routing-decision commits to running
 *                        against a harness that has repo/file
 *                        access. The second-stage
 *                        `codingHarnessRecommendation` flow
 *                        (unchanged) still picks Codex CLI vs
 *                        MiniMax CLI at send time.
 */
export type PanelHarness = "normal_chat" | "repo_file_harness";

export type PanelCostTier = "standard" | "expensive" | "cheap";

/**
 * The four fields the user can edit on the panel. `comment` is a
 * free-form annotation, not a `ChangedFieldKey` — the brief asks
 * for an optional compact comment that does not count as a
 * "correction" for the diff / KPI counters.
 */
export type ChangedFieldKey = "context" | "model" | "reasoning" | "harness";

/**
 * Context decision block on the panel response. Carries its own
 * explanation because this is the most important routing decision
 * and the user may want to correct / comment on it independently
 * of the execution package.
 */
export type RoutingDecisionPanelContext = {
  recommended: ContextDecision;
  explanation: string;
};

/**
 * Execution package block — model + reasoning level + harness,
 * recommended as one unit with a single 1-2 sentence
 * package-level explanation. The brief forbids per-field
 * explanations on the panel by default; the package explanation
 * is the only "why this package" copy.
 */
export type RoutingDecisionPanelPackage = {
  model: {
    recommended: string;
    alternatives: ReadonlyArray<string>;
  };
  reasoningLevel: {
    /**
     * Provider-native reasoning-effort value (e.g. `"low"`,
     * `"medium"`, `"xhigh"`, `"none"`). The literal string
     * `"none"` is the sentinel for "model does not support
     * reasoning controls" — distinct from `null`, which is the
     * legacy wire-shape marker. The panel UI treats both the same
     * way: the dropdown is disabled and the only option shown is
     * `"none"`.
     */
    recommended: string;
    /**
     * Provider-native values the model actually supports. Empty
     * when the model has no reasoning controls — the dropdown is
     * disabled in that case and `recommended` MUST be `"none"`.
     */
    supportedValues: ReadonlyArray<string>;
  };
  harness: {
    recommended: PanelHarness;
    /**
     * Always `[normal_chat, repo_file_harness]` — both are valid
     * panel values regardless of the recommendation, so the user
     * can always switch from one to the other.
     */
    alternatives: ReadonlyArray<PanelHarness>;
  };
  /** Single 1-2 sentence explanation for the whole package. */
  explanation: string;
};

/**
 * Top-level panel payload the route sends to the client. The
 * client renders this verbatim via `RoutingDecisionPanel` and
 * computes `changedFields` locally against the user's final
 * selection.
 */
export type RoutingDecisionPanel = {
  contextDecision: RoutingDecisionPanelContext;
  executionPackage: RoutingDecisionPanelPackage;
  /** 0..1. Placeholder until the recommender exposes a real confidence signal. */
  confidence: number;
  costTier: PanelCostTier;
  /** Wall-clock latency for the recommendation call in milliseconds. */
  latencyMs: number;
};

/**
 * User's final selection when they press `Send with routing`.
 * Captures every field they may have edited plus the diff
 * (so the chat route + telemetry table can record what was a
 * user override vs what came from the recommender).
 */
export type RoutingDecisionPanelSelection = {
  contextDecision: ContextDecision;
  modelId: string;
  reasoningLevel: string;
  harness: PanelHarness;
  changedFields: ReadonlyArray<ChangedFieldKey>;
  comment: string;
};

/**
 * Compute the `changedFields` array for a `RoutingDecisionPanelSelection`
 * against the original `RoutingDecisionPanel`. Pure / deterministic.
 * The `comment` does NOT count toward `changedFields` — the brief
 * calls it out as a free-form annotation.
 */
export function computeChangedFields(
  panel: RoutingDecisionPanel,
  selection: {
    contextDecision: ContextDecision;
    modelId: string;
    reasoningLevel: string;
    harness: PanelHarness;
  },
): ReadonlyArray<ChangedFieldKey> {
  const changed: ChangedFieldKey[] = [];
  if (selection.contextDecision !== panel.contextDecision.recommended) changed.push("context");
  if (selection.modelId !== panel.executionPackage.model.recommended) changed.push("model");
  // The "none" sentinel on the panel recommendation is the same as
  // a user-selected "none" — both mean "no reasoning controls".
  // Compare the raw strings without a separate normalization so the
  // internal representation stays verbatim.
  if (selection.reasoningLevel !== panel.executionPackage.reasoningLevel.recommended) {
    changed.push("reasoning");
  }
  if (selection.harness !== panel.executionPackage.harness.recommended) changed.push("harness");
  return changed;
}

/**
 * Map a panel harness value to the internal chat-route /
 * harness-registry shape.
 *
 * `repo_file_harness` maps to `threadMode: "coding_task"` with
 * `codex_cli` as the default harness id. The brief allows the
 * existing coding-agent path to be the implementation; the panel
 * does NOT let the user pick Codex vs MiniMax at this stage —
 * the second-stage `codingHarnessRecommendation` flow (which
 * is unchanged) handles that choice once the user actually
 * sends.
 */
export function mapHarnessValueToInternal(harness: PanelHarness): {
  threadMode: "chat" | "coding_task";
  harnessId: "codex_cli" | "minimax_cli" | null;
} {
  if (harness === "repo_file_harness") {
    return { threadMode: "coding_task", harnessId: "codex_cli" };
  }
  return { threadMode: "chat", harnessId: null };
}

/**
 * Inverse of `mapHarnessValueToInternal`. Used when the
 * panel state needs to be hydrated from an existing thread
 * (e.g. on a hard reload where the panel was previously
 * dismissed and the user reopened the thread).
 */
export function mapInternalToHarnessValue(args: {
  threadMode: "chat" | "coding_task";
  harnessId: "codex_cli" | "minimax_cli" | null;
}): PanelHarness {
  if (args.threadMode === "coding_task" && args.harnessId) return "repo_file_harness";
  return "normal_chat";
}

/**
 * Build the model id + reasoning level pair that the chat
 * transport should send to `/api/chat`. Implements the brief's
 * "GPT-5.5 low reasoning internal representation" rule:
 *
 *   - The model id is passed verbatim. We do NOT prepend /
 *     strip a provider prefix here; the chat route's resolver
 *     handles `codex:gpt-5.5` vs `gpt-5.5` symmetrically.
 *   - The reasoning level is passed verbatim UNLESS the model
 *     does not support reasoning controls, in which case it is
 *     forced to `null` (the legacy chat-route marker). The
 *     `"none"` panel sentinel and `null` legacy marker are
 *     treated the same way: "no reasoning controls".
 *   - `codex:gpt-5.5` + `reasoningLevel: "low"` stays exactly
 *     that pair — no enum translation, no normalization.
 */
export function executionPayloadModelId(args: {
  modelId: string;
  reasoningLevel: string;
  registry: EffectiveRegistry | null;
}): { modelId: string; reasoningLevel: string | null } {
  const { modelId, reasoningLevel } = args;
  if (!args.registry) {
    // No registry means we cannot validate; pass the reasoning
    // level through. The chat route's preflight will reject
    // stale values with a clear error.
    return { modelId, reasoningLevel };
  }
  const entry = args.registry.models.find((m) => m.modelId === modelId);
  if (!entry) {
    // Unknown model — keep the raw values; the chat route
    // refuses unknown ids with a loud error.
    return { modelId, reasoningLevel };
  }
  if (!entry.supportsReasoningLevels) {
    // The model does not accept reasoning controls. The chat
    // route maps `null` to "do not pass a reasoning value" —
    // the same wire effect as the legacy codex rows.
    return { modelId, reasoningLevel: null };
  }
  return { modelId, reasoningLevel };
}

/**
 * The execution-eligible model id list for the panel's model
 * dropdown. Excludes:
 *   - the configured recommender primary,
 *   - the configured recommender fallback (when set),
 *   - any model id the registry marks as not chat-usable.
 *
 * Hard rule: ROUTER models are NEVER execution models. This
 * helper is the single source of truth for that exclusion.
 *
 * Pure / deterministic given the same inputs. No I/O.
 */
export function getExecutionEligibleModelIds(
  settings: Pick<
    RouterSettings,
    "normalChatRecommenderModelId" | "normalChatRecommenderFallbackModelId"
  >,
  registry: EffectiveRegistry | null,
): ReadonlyArray<string> {
  const blocklist = new Set<string>();
  if (settings.normalChatRecommenderModelId) {
    blocklist.add(settings.normalChatRecommenderModelId);
  }
  if (settings.normalChatRecommenderFallbackModelId) {
    blocklist.add(settings.normalChatRecommenderFallbackModelId);
  }
  if (!registry) return [];
  return registry.models
    .filter((m) => m.manualSelectorVisible && m.usableForChat && !blocklist.has(m.modelId))
    .map((m) => m.modelId);
}