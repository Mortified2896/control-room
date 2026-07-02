"use client";

/**
 * Routing Decision Panel — compact editable panel that
 * replaces the previous step-by-step recommendation card.
 *
 * Renders the new wire payload emitted by `/api/model/recommend`:
 *
 *   - Header: "Routing decision" + confidence badge + cost-tier
 *     badge + latency text.
 *   - Section 1 — Context: dropdown + own explanation.
 *   - Section 2 — Execution package: model / reasoning / harness
 *     dropdowns + ONE package explanation.
 *   - Optional compact comment input.
 *   - Bottom buttons: Send with routing / Send default / Dismiss.
 *
 * Hard rules (from the panel brief):
 *   - The router only RECOMMENDS — it must not silently
 *     override the user's selection. `onSendWithRouting` carries
 *     the user's final pick + the diff + the comment.
 *   - The model dropdown must NEVER include a configured
 *     recommender-chain id (those are decision engines, not
 *     execution models). The parent's
 *     `executionEligibleModels` is pre-filtered for this.
 *   - If the selected model does not support reasoning
 *     controls, the reasoning dropdown is disabled and the
 *     only option shown is "none".
 *   - The recommender does NOT auto-rerun when the user
 *     changes a dropdown — the panel's local state owns the
 *     selection until the user presses one of the bottom
 *     buttons.
 */

import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  computeChangedFields,
  type ChangedFieldKey,
  type ContextDecision,
  type PanelHarness,
  type RoutingDecisionPanel,
  type RoutingDecisionPanelSelection,
} from "@/lib/router/routing-decision-panel-types";
import {
  classifyLatencyTier,
  costTierBadgeClass,
  costTierBadgeLabel,
} from "@/lib/router/recommendation-shape";

/**
 * One execution-eligible model row for the panel dropdown.
 * `executionEligibleModels` is pre-filtered by the parent so it
 * NEVER contains a configured recommender-chain id.
 */
export type RoutingDecisionPanelModelOption = {
  modelId: string;
  displayLabel: string;
  providerId: "openai" | "codex" | "minimax";
  /**
   * `true` when the model advertises provider-native reasoning
   * controls. When `false`, the panel renders the reasoning
   * dropdown as a single disabled "none" option.
   */
  supportsReasoningControls: boolean;
  /**
   * Provider-native option values the model advertises. May be
   * empty when `supportsReasoningControls` is `false`.
   */
  allowedReasoningLevels: ReadonlyArray<string>;
  tier: "cheap" | "expensive" | "standard";
};

export type RoutingDecisionPanelProps = {
  panel: RoutingDecisionPanel;
  executionEligibleModels: ReadonlyArray<RoutingDecisionPanelModelOption>;
  onSendWithRouting: (selection: RoutingDecisionPanelSelection) => void;
  onSendDefault: () => void;
  onDismiss: () => void;
  /**
   * When `true`, the panel renders a loud-failure notice and
   * the model dropdown is disabled. The "Send with routing"
   * button stays available so the user can still confirm the
   * current selection; "Send default" remains the safe fallback
   * (it bypasses the recommendation entirely).
   */
  loudFailure?: boolean;
  /**
   * Optional pre-populated values (e.g. when re-opening the
   * panel after a dismissed session). When omitted the panel
   * starts from the recommendation's recommended values.
   */
  initialSelection?: Partial<RoutingDecisionPanelSelection>;
};

const HARNESS_OPTIONS: ReadonlyArray<{
  value: PanelHarness;
  label: string;
}> = [
  { value: "normal_chat", label: "Normal chat" },
  { value: "repo_file_harness", label: "Repo/file harness" },
];

const CONTEXT_OPTIONS: ReadonlyArray<{
  value: ContextDecision;
  label: string;
}> = [
  { value: "chat_only", label: "Chat only" },
  { value: "harness_needed", label: "Harness needed" },
];

const LATENCY_TEXT: Record<"fast" | "normal" | "slow", string> = {
  fast: "<2s",
  normal: "2-8s",
  slow: ">8s",
};

export function RoutingDecisionPanel({
  panel,
  executionEligibleModels,
  onSendWithRouting,
  onSendDefault,
  onDismiss,
  loudFailure = false,
  initialSelection,
}: RoutingDecisionPanelProps) {
  const [contextDecision, setContextDecision] = useState<ContextDecision>(
    initialSelection?.contextDecision ?? panel.contextDecision.recommended,
  );
  const [modelId, setModelId] = useState<string>(
    initialSelection?.modelId ?? panel.executionPackage.model.recommended,
  );
  const [reasoningLevel, setReasoningLevel] = useState<string>(
    initialSelection?.reasoningLevel ??
      panel.executionPackage.reasoningLevel.recommended,
  );
  const [harness, setHarness] = useState<PanelHarness>(
    initialSelection?.harness ?? panel.executionPackage.harness.recommended,
  );
  const [comment, setComment] = useState<string>(initialSelection?.comment ?? "");
  const [commentOpen, setCommentOpen] = useState<boolean>(Boolean(initialSelection?.comment));

  // Reset local state when the panel payload changes (e.g. a
  // new recommendation arrives). The `panel` object is the
  // identity; we re-init from its current shape.
  useEffect(() => {
    setContextDecision(panel.contextDecision.recommended);
    setModelId(panel.executionPackage.model.recommended);
    setReasoningLevel(panel.executionPackage.reasoningLevel.recommended);
    setHarness(panel.executionPackage.harness.recommended);
    setComment("");
    setCommentOpen(false);
  }, [panel]);

  const selectedModel: RoutingDecisionPanelModelOption | null = useMemo(() => {
    const m = executionEligibleModels.find((opt) => opt.modelId === modelId);
    return m ?? null;
  }, [executionEligibleModels, modelId]);

  // Reasoning options for the dropdown. When the model does not
  // support reasoning controls, the dropdown is disabled and the
  // only option is "none" — matching the brief's "if selected
  // model does not support reasoning levels, show 'none' and
  // disable the dropdown" rule.
  const reasoningOptions: ReadonlyArray<string> = useMemo(() => {
    if (!selectedModel) return ["none"];
    if (!selectedModel.supportsReasoningControls) return ["none"];
    const modelOptions = selectedModel.allowedReasoningLevels;
    const panelOptions = panel.executionPackage.reasoningLevel.supportedValues;
    if (modelOptions.length === 0) return ["none"];
    // Intersect the model's options with the panel's recommended
    // set so a stale panel recommendation cannot expose a level
    // the model has since rejected. The intersection is
    // symmetric — both sets are provider-native strings.
    const set = new Set(modelOptions);
    const intersected = panelOptions.filter((v) => set.has(v));
    return intersected.length > 0 ? intersected : modelOptions;
  }, [selectedModel, panel]);

  // If the selected model lost support for the user's reasoning
  // pick, fall back to the model's first supported option (or
  // "none" when there are none). This is the brief's "disabled
  // or reset safely" rule.
  useEffect(() => {
    if (!selectedModel) return;
    if (!selectedModel.supportsReasoningControls) {
      if (reasoningLevel !== "none") setReasoningLevel("none");
      return;
    }
    if (!reasoningOptions.includes(reasoningLevel)) {
      setReasoningLevel(reasoningOptions[0] ?? "none");
    }
  }, [selectedModel, reasoningOptions, reasoningLevel]);

  const changedFields: ReadonlyArray<ChangedFieldKey> = useMemo(
    () =>
      computeChangedFields(panel, {
        contextDecision,
        modelId,
        reasoningLevel,
        harness,
      }),
    [panel, contextDecision, modelId, reasoningLevel, harness],
  );

  const handleSendWithRouting = () => {
    onSendWithRouting({
      contextDecision,
      modelId,
      reasoningLevel,
      harness,
      changedFields,
      comment,
    });
  };

  const latencyTier = classifyLatencyTier(panel.latencyMs);
  const confidencePct = Math.round(Math.max(0, Math.min(1, panel.confidence)) * 100);
  const costLabel = costTierBadgeLabel(panel.costTier);
  const costClass = costTierBadgeClass(panel.costTier);

  return (
    <div
      data-testid="routing-decision-panel"
      className="my-1 rounded-2xl border border-primary/20 bg-primary/5 p-3 text-xs"
    >
      {/* Header row */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="font-semibold text-foreground">Routing decision</div>
        <span
          data-testid="routing-decision-confidence-badge"
          className="inline-flex items-center rounded-full border border-border/60 bg-background/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
          title={`Recommender confidence (${confidencePct}%)`}
        >
          Confidence {confidencePct}%
        </span>
        <span
          data-testid="routing-decision-cost-tier-badge"
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${costClass}`}
          title={`Estimated cost tier: ${costLabel}`}
        >
          {costLabel}
        </span>
        <span
          data-testid="routing-decision-latency"
          className="inline-flex items-center rounded-full border border-border/60 bg-background/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
          title={`Recommendation took ${panel.latencyMs}ms (${LATENCY_TEXT[latencyTier]})`}
        >
          {(panel.latencyMs / 1000).toFixed(1)}s · {LATENCY_TEXT[latencyTier]}
        </span>
      </div>

      {loudFailure ? (
        <div
          data-testid="routing-decision-loud-failure-notice"
          className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-destructive"
        >
          Recommender could not run. Your manual selection is preserved; switch the
          model dropdown or click Send default to proceed without routing.
        </div>
      ) : null}

      {/* Section 1 — Context */}
      <section
        data-testid="routing-decision-context-section"
        className="mt-3 grid gap-2"
      >
        <div className="flex items-center justify-between">
          <Label htmlFor="routing-decision-context-select" className="font-medium text-foreground">
            Context
          </Label>
        </div>
        <select
          id="routing-decision-context-select"
          data-testid="routing-decision-context-select"
          data-current-context={contextDecision}
          className="h-7 rounded-md border border-input bg-background px-2 text-xs"
          value={contextDecision}
          onChange={(e) => setContextDecision(e.target.value as ContextDecision)}
        >
          {CONTEXT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <p
          data-testid="routing-decision-context-explanation"
          className="text-[11px] text-muted-foreground"
        >
          {panel.contextDecision.explanation}
        </p>
      </section>

      {/* Section 2 — Execution package */}
      <section
        data-testid="routing-decision-package-section"
        className="mt-3 grid gap-2"
      >
        <div className="flex items-center justify-between">
          <Label className="font-medium text-foreground">Execution package</Label>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(140px,1fr)_minmax(160px,1fr)]">
          {/* Model dropdown */}
          <div className="min-w-0 grid gap-1 overflow-hidden">
            <Label htmlFor="routing-decision-model-select" className="text-[11px] text-muted-foreground">
              Model
            </Label>
            <select
              id="routing-decision-model-select"
              data-testid="routing-decision-model-select"
              data-current-model={modelId}
              className="h-7 w-full max-w-full overflow-hidden rounded-md border border-input bg-background px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
              value={modelId}
              disabled={loudFailure || executionEligibleModels.length === 0}
              onChange={(e) => setModelId(e.target.value)}
            >
              {executionEligibleModels.length === 0 ? (
                <option value={modelId}>{modelId || "(no models available)"}</option>
              ) : (
                executionEligibleModels.map((m) => (
                  <option key={m.modelId} value={m.modelId}>
                    {m.displayLabel}
                  </option>
                ))
              )}
            </select>
          </div>
          {/* Reasoning dropdown */}
          <div className="min-w-0 grid gap-1 overflow-hidden">
            <Label htmlFor="routing-decision-reasoning-select" className="text-[11px] text-muted-foreground">
              Reasoning
            </Label>
            <select
              id="routing-decision-reasoning-select"
              data-testid="routing-decision-reasoning-select"
              data-current-reasoning={reasoningLevel}
              className="h-7 w-full max-w-full overflow-hidden rounded-md border border-input bg-background px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
              value={reasoningLevel}
              disabled={!selectedModel?.supportsReasoningControls}
              onChange={(e) => setReasoningLevel(e.target.value)}
            >
              {reasoningOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
          {/* Harness dropdown */}
          <div className="min-w-0 grid gap-1 overflow-hidden">
            <Label htmlFor="routing-decision-harness-select" className="text-[11px] text-muted-foreground">
              Harness
            </Label>
            <select
              id="routing-decision-harness-select"
              data-testid="routing-decision-harness-select"
              data-current-harness={harness}
              className="h-7 w-full max-w-full overflow-hidden rounded-md border border-input bg-background px-2 text-xs"
              value={harness}
              onChange={(e) => setHarness(e.target.value as PanelHarness)}
            >
              {HARNESS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p
          data-testid="routing-decision-package-explanation"
          className="text-[11px] text-muted-foreground"
        >
          {panel.executionPackage.explanation}
        </p>
      </section>

      {/* Optional compact comment */}
      <section className="mt-3 grid gap-1">
        {!commentOpen ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="routing-decision-comment-toggle"
            className="h-6 justify-start px-2 text-[11px]"
            onClick={() => setCommentOpen(true)}
          >
            Comment on recommendation
          </Button>
        ) : (
          <div className="grid gap-1">
            <Label htmlFor="routing-decision-comment-input" className="text-[11px] text-muted-foreground">
              Comment on recommendation
            </Label>
            <Input
              id="routing-decision-comment-input"
              data-testid="routing-decision-comment-input"
              placeholder="Optional. e.g. 'Model was too expensive for this.'"
              value={comment}
              maxLength={1000}
              onChange={(e) => setComment(e.target.value)}
              className="h-7 text-xs"
            />
          </div>
        )}
      </section>

      {/* Bottom buttons */}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          className="h-7 rounded-full px-3"
          data-testid="routing-decision-send-with-routing"
          onClick={handleSendWithRouting}
        >
          Send with routing
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 rounded-full px-3"
          data-testid="routing-decision-send-default"
          onClick={onSendDefault}
        >
          Send default
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 rounded-full px-3"
          data-testid="routing-decision-dismiss"
          onClick={onDismiss}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}