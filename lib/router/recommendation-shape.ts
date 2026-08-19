/**
 * Shared shape helpers for the new routing-decision panel.
 *
 * The brief asks for several specific shape concerns that are
 * independent of the model call. Centralizing them here lets the
 * route and the panel-builder reuse the same definitions.
 */

import type {
  PanelCostTier,
  RoutingDecisionPanel,
} from "./routing-decision-panel-types";
import type { EffectiveRegistry } from "@/lib/providers/registry";

/**
 * Classify a recommendation's actual latency into a coarse
 * bucket the panel can render as a 1-2 word latency text.
 *
 *   - "fast"   — under 2 seconds.
 *   - "normal" — 2-8 seconds.
 *   - "slow"   — over 8 seconds.
 *
 * The bucketing uses the actual latency only — not the
 * expected / upper bound — because the panel header shows
 * what the recommender just took, not what it expected to
 * take.
 */
export function classifyLatencyTier(latencyMs: number): "fast" | "normal" | "slow" {
  if (latencyMs < 2000) return "fast";
  if (latencyMs < 8000) return "normal";
  return "slow";
}

/**
 * Resolve the cost-tier badge text the panel renders in the
 * header. The mapping is purely a label; the underlying
 * `PanelCostTier` enum is the data the panel renders against.
 */
export function costTierBadgeLabel(tier: PanelCostTier): string {
  switch (tier) {
    case "expensive":
      return "Expensive";
    case "cheap":
      return "Cheap";
    case "standard":
    default:
      return "Standard";
  }
}

/**
 * Resolve the cost-tier badge CSS class for the header pill.
 * Tailwind classes are pinned here so the panel component
 * doesn't need to re-derive the styling rules.
 */
export function costTierBadgeClass(tier: PanelCostTier): string {
  switch (tier) {
    case "expensive":
      return "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-200";
    case "cheap":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200";
    case "standard":
    default:
      return "border-border/60 bg-muted/30 text-muted-foreground";
  }
}

/**
 * Resolve the panel's `costTier` from the live registry. The
 * mapping is the single source of truth for the wire value:
 *
 *   - `expensive` registry tier → `PanelCostTier = "expensive"`.
 *   - `cheap`     registry tier → `PanelCostTier = "cheap"`.
 *   - `standard` / `unknown`   → `PanelCostTier = "standard"`.
 *
 * The mapping is conservative: unknown tiers are surfaced as
 * `standard` rather than the more optimistic `cheap` because
 * the brief asks for "no silent API-billing fallback" and the
 * UI must not advertise a model as cheap when the registry
 * hasn't classified it.
 */
export function estimatePanelCostTier(
  modelId: string,
  registry: EffectiveRegistry | null,
): PanelCostTier {
  if (!registry) return "standard";
  const entry = registry.models.find((m) => m.modelId === modelId);
  if (!entry) return "standard";
  switch (entry.tier) {
    case "expensive":
      return "expensive";
    case "cheap":
      return "cheap";
    case "standard":
    case "unknown":
    default:
      return "standard";
  }
}

/**
 * Resolve the panel's `confidence` from the recommender's
 * reasoning level pick. Placeholder heuristic until the
 * recommender exposes a real confidence signal:
 *
 *   - `low`     → 0.70
 *   - `medium`  → 0.85
 *   - `high`    → 0.95
 *   - `xhigh`   → 0.99
 *   - anything else (including `"none"`) → 0.65
 *
 * The placeholder is documented as such in the route so a
 * future refactor can replace it with the real recommender
 * signal without changing the wire shape.
 */
export function derivePanelConfidence(args: {
  reasoningLevel: string;
  reasoningSupportedValues: ReadonlyArray<string>;
}): number {
  const lvl = args.reasoningLevel;
  if (!args.reasoningSupportedValues.includes(lvl)) return 0.65;
  switch (lvl) {
    case "low":
      return 0.7;
    case "medium":
      return 0.85;
    case "high":
      return 0.92;
    case "xhigh":
      return 0.97;
    default:
      return 0.7;
  }
}

/**
 * Sanity-check a `RoutingDecisionPanel` payload before it
 * leaves the route. Throws a tagged error if any required
 * field is missing so a regression in the builder cannot
 * silently emit a malformed panel. Pure / no I/O.
 */
export class PanelShapeError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "PanelShapeError";
    this.field = field;
  }
}

export function assertPanelShape(panel: RoutingDecisionPanel): void {
  if (!panel.contextDecision) {
    throw new PanelShapeError("contextDecision", "panel.contextDecision is required");
  }
  if (
    panel.contextDecision.recommended !== "chat_only" &&
    panel.contextDecision.recommended !== "harness_needed"
  ) {
    throw new PanelShapeError(
      "contextDecision.recommended",
      `unexpected context decision: ${panel.contextDecision.recommended}`,
    );
  }
  if (typeof panel.contextDecision.explanation !== "string") {
    throw new PanelShapeError(
      "contextDecision.explanation",
      "context explanation must be a string",
    );
  }
  if (!panel.executionPackage) {
    throw new PanelShapeError("executionPackage", "panel.executionPackage is required");
  }
  if (!panel.executionPackage.model) {
    throw new PanelShapeError("executionPackage.model", "executionPackage.model is required");
  }
  if (typeof panel.executionPackage.model.recommended !== "string") {
    throw new PanelShapeError(
      "executionPackage.model.recommended",
      "executionPackage.model.recommended must be a string",
    );
  }
  if (typeof panel.executionPackage.explanation !== "string") {
    throw new PanelShapeError(
      "executionPackage.explanation",
      "executionPackage.explanation must be a string",
    );
  }
  if (typeof panel.confidence !== "number" || panel.confidence < 0 || panel.confidence > 1) {
    throw new PanelShapeError(
      "confidence",
      `panel.confidence must be in [0,1], got ${panel.confidence}`,
    );
  }
  if (
    panel.costTier !== "standard" &&
    panel.costTier !== "expensive" &&
    panel.costTier !== "cheap"
  ) {
    throw new PanelShapeError("costTier", `unexpected costTier: ${panel.costTier}`);
  }
  if (typeof panel.latencyMs !== "number" || panel.latencyMs < 0) {
    throw new PanelShapeError(
      "latencyMs",
      `panel.latencyMs must be a non-negative number, got ${panel.latencyMs}`,
    );
  }
}