"use client";

import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  FlaskConical,
  Loader2,
  Plug,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

import { BillingTag } from "./registry-helpers";
import type { EffectiveRegistryModelDto } from "./types";
import type { ReasoningCapability } from "@/lib/providers/capability";
import {
  describeReasoningCapability,
  getEffectiveReasoningLevels,
  getThinkingModeOptionValues,
  UNKNOWN_REASONING_CAPABILITY,
} from "@/lib/providers/capability";

/**
 * Tab B — Recommender engine.
 *
 *   "What model recommends?"
 *
 * A compact settings card (NOT a table). The engine-side controls plus
 * a read-only prompt preview so the user always sees what the
 * recommender is actually being told:
 *
 *   - Engine model              → model id of the recommender
 *   - Engine reasoning/thinking → provider-native option for the
 *                                 engine model (low/medium/xhigh on
 *                                 OpenAI/Codex effort-level models,
 *                                 adaptive/enabled/disabled on MiniMax
 *                                 thinking-budget models)
 *   - Fallback engine model     → optional single-model fallback
 *                                 (the recommender tries it right
 *                                 after the primary engine fails and
 *                                 BEFORE the deterministic Codex →
 *                                 MiniMax → OpenAI API defaults)
 *   - Fallback reasoning        → reasoning level used when the
 *                                 fallback model is the active
 *                                 recommender
 *   - Prompt preview            → the system + user prompts the API
 *                                 route actually sends to the
 *                                 recommender (read-only, live, so
 *                                 the user never has to guess what
 *                                 "prompt" the engine is using)
 *   - Status                    → runtime reachability + billing
 *                                 kind (subscription-backed vs
 *                                 API-billed)
 *   - Test recommender engine   → fires a smoke call against the
 *                                 configured engine and surfaces
 *                                 the result inline (loud error on
 *                                 failure; never silent fallback).
 *
 * Backend fields:
 *   - `normalChatRecommenderModelId`             (engine model)
 *   - `normalChatRecommenderReasoningLevel`      (engine reasoning/thinking)
 *   - `normalChatRecommenderFallbackModelId`     (optional fallback model)
 *   - `normalChatRecommenderFallbackReasoningLevel` (fallback reasoning)
 *
 * Settings owned here are deliberately kept separate from the candidate
 * pool (Tab C). The engine and the candidates are not the same
 * decision — a Codex subscription engine is allowed to recommend a
 * MiniMax M3 candidate, for example.
 *
 * Loud-failure policy enforced here:
 *   - If the engine model is misconfigured / unconfigured, the Status
 *     pill says "Unavailable" and Save is disabled until the user
 *     picks a different engine (we never silently fall back).
 *   - If the user's pick is OpenAI API and `allowOpenAiApiRouter` is
 *     off, the same pill surfaces "API-billed — opt-in required" so the
 *     user must explicitly accept the cost.
 *   - If the engine model is Codex and Codex is currently quota-
 *     exhausted, the pill stays "Subscription-backed / Quota exhausted"
 *     — the brief: "Treat Codex as configured / catalogued but
 *     temporarily unavailable for runtime." No silent swap to MiniMax
 *     or OpenAI.
 *   - The user-configured fallback is optional and respects the same
 *     OpenAI API opt-in as the primary engine. When unset, the
 *     deterministic Codex → MiniMax → OpenAI API defaults remain
 *     unchanged.
 */

type EngineOption = {
  modelId: string;
  displayLabel: string;
  providerLabel: string;
  providerId: "openai" | "codex" | "minimax";
  billingSource: "subscription" | "api_billing";
  capability: ReasoningCapability;
};

type EngineStatus =
  | { kind: "available"; detail: string }
  | { kind: "test_pass"; detail: string; at: number }
  | { kind: "test_fail"; detail: string; at: number }
  | {
      kind: "unavailable";
      reason:
        | "unconfigured"
        | "missing_key"
        | "provider_disabled"
        | "codex_quota_exhausted"
        | "api_billed_no_opt_in"
        | "candidate_pool_empty"
        | "unknown";
      detail: string;
    };

type RecommenderEngineTabProps = {
  registry: ReadonlyArray<EffectiveRegistryModelDto>;
  /** Currently-selected engine model id (== `normalChatRecommenderModelId`). */
  engineModelId: string;
  /** Currently-selected engine reasoning/thinking option. */
  engineReasoningOption: string;
  /**
   * `true` when the user has explicitly opted in to OpenAI API router
   * use (needed for engine = OpenAI API). Surfaced in the Status pill
   * along with the engine's billing source.
   */
  allowOpenAiApiRouter: boolean;
  /** Optional prebuilt engine options; defaults to building from the registry. */
  engineOptions?: ReadonlyArray<EngineOption>;
  /**
   * Number of candidates the recommender would actually be allowed to
   * pick from given the current Tab C settings. The brief asks us to
   * show this prominently so the user understands what the engine is
   * picking *within*.
   */
  candidatePoolSize: number;
  /** Persist the engine model id. Empty / null means clear / use defaults. */
  onEngineModelChange: (modelId: string) => void;
  /** Persist the engine reasoning/thinking option. */
  onEngineReasoningChange: (option: string) => void;
  /**
   * Optional user-configured fallback model. `null` = no fallback
   * (the deterministic Codex → MiniMax → OpenAI API chain is used).
   * Non-null = the chain tries this model right after the configured
   * primary fails.
   */
  fallbackModelId: string | null;
  /** Reasoning level for the fallback model. `null` when no fallback. */
  fallbackReasoningOption: string | null;
  /** Persist the fallback model id. `null` means clear the fallback. */
  onFallbackModelChange: (modelId: string | null) => void;
  /** Persist the fallback reasoning option. `null` means clear it. */
  onFallbackReasoningChange: (option: string | null) => void;
  /**
   * Read-only prompt preview for the engine. Built by the API route
   * using the live registry so the user sees exactly the prompt body
   * the recommender is sent. `null` when the API has not loaded yet.
   */
  promptPreview: {
    system: string;
    /** Pretty-printed JSON of the user prompt body. */
    userJsonExample: string;
  } | null;
  /**
   * Fire a smoke test against the configured engine. Returns the
   * status object for rendering. Caller owns the network path; we just
   * surface the result.
   */
  onTestEngine: () => Promise<EngineStatus>;
  /** Error from the most recent Save, if any. */
  saveError?: string | null;
  /** Test ID override; defaults to `router-settings-section-recommender-engine`. */
  testId?: string;
};

/**
 * Build the default engine-options list from the registry. The engine
 * model is allowed to be ANY configured provider — Codex, MiniMax, or
 * OpenAI API when opted in. The OpenAI API entry is hidden when
 * `allowOpenAiApiRouter === false` so the user cannot accidentally
 * configure it.
 */
function buildDefaultEngineOptions(
  registry: ReadonlyArray<EffectiveRegistryModelDto>,
  allowOpenAiApiRouter: boolean,
): EngineOption[] {
  const options: EngineOption[] = [];
  for (const entry of registry) {
    if (!entry.configured) continue;
    // Skip openai_api when the user has not opted in — the brief is
    // explicit: API-billed models are not used as fallback and not
    // used as engine either unless explicitly approved.
    if (entry.providerId === "openai" && !allowOpenAiApiRouter) continue;
    options.push({
      modelId: entry.modelId,
      displayLabel: entry.displayLabel,
      providerLabel: entry.providerLabel,
      providerId: entry.providerId === "openai" ? "openai" : entry.providerId,
      billingSource: entry.billingSource,
      capability: entry.reasoningCapability,
    });
  }
  options.sort((a, b) => {
    if (a.providerId !== b.providerId) return a.providerId.localeCompare(b.providerId);
    return a.modelId.localeCompare(b.modelId);
  });
  return options;
}

/**
 * Choose the available reasoning/thinking options for a given engine
 * capability. We surface:
 *
 *   - For `effort_levels` (OpenAI/Codex): the provider-native option
 *     values (e.g. `["none", "low", "medium", "high", "xhigh"]`).
 *     When the option set is unknown / no-metadata, the picker shows a
 *     single "Unknown / provider default" entry.
 *
 *   - For `thinking_budget` (MiniMax M3): the well-known thinking
 *     modes (`["provider_default", "adaptive", "enabled", "disabled"]`).
 *     No fake "low" — matches the brief's explicit rule.
 *
 *   - For `none` / `unknown`: a single "Unsupported by engine" entry
 *     with no value (we never render fake options).
 */
function optionsForCapability(capability: ReasoningCapability): ReadonlyArray<{
  value: string;
  label: string;
}> {
  if (capability.kind === "effort_levels") {
    if (capability.control === "supported" || capability.control === "model_dependent") {
      return capability.options.map((opt) => ({
        value: opt.value,
        label: opt.label ?? opt.value,
      }));
    }
    // `unknown` effort-level capability: be honest.
    return [{ value: "", label: "Unknown / provider default" }];
  }
  if (capability.kind === "thinking_budget") {
    const modes = getThinkingModeOptionValues(capability);
    if (modes.length > 0) {
      return modes.map((v) => ({ value: v, label: v }));
    }
    if (capability.control === "supported" || capability.control === "model_dependent") {
      // supported but no modes advertised — fall back to common
      // provider-native mode names.
      return [
        { value: "provider_default", label: "provider_default" },
        { value: "adaptive", label: "adaptive" },
        { value: "enabled", label: "enabled" },
        { value: "disabled", label: "disabled" },
      ];
    }
    return [{ value: "", label: "Unknown / provider default" }];
  }
  // `none` / `unknown`: engine cannot accept reasoning controls; render
  // a disabled option.
  return [{ value: "", label: "Unsupported by engine" }];
}

/**
 * Derive the pill we render next to the engine model picker. This is
 * the user-facing summary of "is this engine actually able to run?".
 */
function computeEngineStatus(input: {
  selected: EngineOption | undefined;
  registry: ReadonlyArray<EffectiveRegistryModelDto>;
  candidatePoolSize: number;
  allowOpenAiApiRouter: boolean;
  testResult: EngineStatus | null;
}): EngineStatus {
  const { selected, registry, candidatePoolSize, allowOpenAiApiRouter, testResult } = input;
  if (!selected) {
    return {
      kind: "unavailable",
      reason: "unconfigured",
      detail: "Engine model is not configured. Pick a model above.",
    };
  }
  // API-billed engine + opt-in off → fail loud.
  if (selected.billingSource === "api_billing" && !allowOpenAiApiRouter) {
    return {
      kind: "unavailable",
      reason: "api_billed_no_opt_in",
      detail:
        "OpenAI API router use is disabled. Set Settings → Router → 'Allow OpenAI API router use' to opt in before saving.",
    };
  }
  // Candidate pool empty → fail loud (the recommender would have nothing to pick).
  if (candidatePoolSize === 0) {
    return {
      kind: "unavailable",
      reason: "candidate_pool_empty",
      detail:
        "No recommender candidates are enabled. Enable at least one model in Tab C before saving.",
    };
  }
  // Provider quota exhausted (Codex today) → loud "Quota exhausted", not silent fallback.
  if (selected.providerId === "codex") {
    const codexEntry = registry.find(
      (m) => m.providerId === "codex" && m.modelId === selected.modelId,
    );
    if (codexEntry && !codexEntry.available && codexEntry.stale === false) {
      return {
        kind: "unavailable",
        reason: "codex_quota_exhausted",
        detail:
          "Codex is currently quota-exhausted. Treat as configured / catalogued but temporarily unavailable — Control Room will not silently fall back to a different engine.",
      };
    }
  }
  if (testResult) return testResult;
  return {
    kind: "available",
    detail:
      selected.billingSource === "subscription"
        ? "Subscription-backed engine. No silent fallback will run even if this engine fails."
        : "OpenAI API engine, opted in. No silent fallback will run even if this engine fails.",
  };
}

export const RecommenderEngineTab: FC<RecommenderEngineTabProps> = ({
  registry,
  engineModelId,
  engineReasoningOption,
  allowOpenAiApiRouter,
  engineOptions,
  candidatePoolSize,
  onEngineModelChange,
  onEngineReasoningChange,
  fallbackModelId,
  fallbackReasoningOption,
  onFallbackModelChange,
  onFallbackReasoningChange,
  promptPreview,
  onTestEngine,
  saveError = null,
  testId = "router-settings-section-recommender-engine",
}) => {
  const options = useMemo<ReadonlyArray<EngineOption>>(
    () => engineOptions ?? buildDefaultEngineOptions(registry, allowOpenAiApiRouter),
    [registry, engineOptions, allowOpenAiApiRouter],
  );

  const selectedOption = useMemo(() => {
    const direct = options.find((o) => o.modelId === engineModelId);
    if (direct) return direct;
    // The persisted engine id may point at a row that is no longer in
    // the engine options (provider disabled / opt-in off / stale). We
    // synthesize a minimal option so the picker still surfaces the
    // current value and the Test button stays enabled when the model
    // could plausibly resolve at runtime.
    return {
      modelId: engineModelId,
      displayLabel: `${engineModelId} (current — provider disabled or unknown)`,
      providerLabel: "Unknown",
      providerId: "openai" as const,
      billingSource: "api_billing" as const,
      capability: UNKNOWN_REASONING_CAPABILITY,
    };
  }, [options, engineModelId]);

  const reasoningChoices = useMemo(
    () =>
      selectedOption
        ? optionsForCapability(selectedOption.capability)
        : [{ value: "", label: "Pick an engine model" }],
    [selectedOption],
  );

  /**
   * Fallback option: resolves the persisted fallback model id to the
   * matching `EngineOption` (or synthesizes a minimal option for
   * stale / unknown rows, matching the primary picker pattern). The
   * fallback picker always includes an explicit "No fallback"
   * option so the user can clear it without deleting the row.
   */
  const fallbackOptions = useMemo<ReadonlyArray<EngineOption>>(
    () => buildDefaultEngineOptions(registry, allowOpenAiApiRouter),
    [registry, allowOpenAiApiRouter],
  );
  const fallbackSelectedOption = useMemo<EngineOption | null>(() => {
    if (!fallbackModelId) return null;
    const direct = fallbackOptions.find((o) => o.modelId === fallbackModelId);
    if (direct) return direct;
    return {
      modelId: fallbackModelId,
      displayLabel: `${fallbackModelId} (current — provider disabled or unknown)`,
      providerLabel: "Unknown",
      providerId: "openai" as const,
      billingSource: "api_billing" as const,
      capability: UNKNOWN_REASONING_CAPABILITY,
    };
  }, [fallbackOptions, fallbackModelId]);
  const fallbackReasoningChoices = useMemo(
    () =>
      fallbackSelectedOption
        ? optionsForCapability(fallbackSelectedOption.capability)
        : [{ value: "", label: "Pick a fallback model" }],
    [fallbackSelectedOption],
  );

  const [testState, setTestState] = useState<EngineStatus | null>(null);
  const [testing, setTesting] = useState(false);

  /**
   * Re-derive status when inputs change. We intentionally keep the
   * computed status in component-state so the Test button can persist
   * its own outcome without immediately overwriting it on every form
   * keystroke.
   */
  const derivedStatus = useMemo(
    () =>
      computeEngineStatus({
        selected: selectedOption,
        registry,
        candidatePoolSize,
        allowOpenAiApiRouter,
        testResult: testState,
      }),
    [selectedOption, registry, candidatePoolSize, allowOpenAiApiRouter, testState],
  );

  /**
   * Reset the test status whenever the user changes the engine model
   * or reasoning, so a stale pass / fail doesn't bleed across edits.
   */
  useEffect(() => {
    setTestState(null);
  }, [engineModelId, engineReasoningOption, fallbackModelId, fallbackReasoningOption]);

  const runTest = useCallback(async () => {
    setTesting(true);
    try {
      const result = await onTestEngine();
      setTestState(result);
    } finally {
      setTesting(false);
    }
  }, [onTestEngine]);

  const status = derivedStatus;

  const statusBg = (() => {
    if (status.kind === "available" || status.kind === "test_pass")
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    if (status.kind === "test_fail")
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    return "border-destructive/40 bg-destructive/10 text-destructive";
  })();

  const statusIcon = (() => {
    if (status.kind === "available") return <CheckCircle2 className="size-3.5 shrink-0" />;
    if (status.kind === "test_pass") return <CheckCircle2 className="size-3.5 shrink-0" />;
    if (status.kind === "test_fail") return <AlertTriangle className="size-3.5 shrink-0" />;
    return <XCircle className="size-3.5 shrink-0" />;
  })();

  return (
    <section
      aria-labelledby="recommender-engine-heading"
      className="rounded-lg border border-border/60 bg-card p-4 sm:p-6"
      data-testid={testId}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="recommender-engine-heading" className="text-sm font-semibold">
            B · Recommender engine
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            This is the model that reads the user prompt and recommends a chat model. It is separate
            from the candidate pool (Tab C) — a subscription-backed engine is allowed to recommend
            MiniMax M3, for example. If this engine is unavailable, Control Room will not silently
            fall back to a different engine.
          </p>
        </div>
        <div
          data-testid="recommender-engine-status"
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs",
            statusBg,
          )}
        >
          {statusIcon}
          <span className="font-medium">
            {status.kind === "available"
              ? "Available"
              : status.kind === "test_pass"
                ? "Test passed"
                : status.kind === "test_fail"
                  ? "Test failed"
                  : "Unavailable"}
          </span>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        {/* Engine model picker */}
        <div className="rounded-md border border-border/60 px-3 py-3">
          <Label htmlFor="recommender-engine-model">Engine model</Label>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Cheap, fast model. Codex subscription is the safe default; MiniMax M3 is a subscription
            fallback; OpenAI API is opt-in only.
          </p>
          <select
            id="recommender-engine-model"
            data-testid="router-settings-normal-chat-recommender-model"
            value={engineModelId}
            onChange={(e) => onEngineModelChange(e.target.value)}
            className="border-input bg-background mt-2 flex h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none"
            aria-invalid={status.kind === "unavailable"}
          >
            {!options.some((o) => o.modelId === engineModelId) && (
              <option value={engineModelId}>
                {engineModelId} (current — provider disabled or unknown)
              </option>
            )}
            {options.map((o) => (
              <option key={o.modelId} value={o.modelId}>
                {o.displayLabel} · {billingShortLabel(o.billingSource)}
              </option>
            ))}
          </select>
          {selectedOption ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <BillingTag
                billingSource={selectedOption.billingSource}
                testId="recommender-engine-billing"
              />
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                {selectedOption.providerId}
              </span>
            </div>
          ) : null}
        </div>

        {/* Engine thinking / reasoning option picker */}
        <div className="rounded-md border border-border/60 px-3 py-3">
          <Label htmlFor="recommender-engine-thinking">Engine reasoning / thinking</Label>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Provider-native value sent verbatim to the engine. Codex / OpenAI effort-level models
            use <code className="rounded bg-muted px-1">low | medium | high | xhigh</code>; MiniMax
            M3 uses{" "}
            <code className="rounded bg-muted px-1">
              provider_default | adaptive | enabled | disabled
            </code>
            .
          </p>
          <select
            id="recommender-engine-thinking"
            data-testid="router-settings-normal-chat-recommender-reasoning"
            value={engineReasoningOption}
            onChange={(e) => onEngineReasoningChange(e.target.value)}
            disabled={!selectedOption || reasoningChoices.length === 0}
            className="border-input bg-background mt-2 flex h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none disabled:opacity-60"
          >
            {reasoningChoices.map((choice, idx) => (
              <option key={`${choice.value}-${idx}`} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
          {selectedOption ? (
            <p
              className="mt-2 text-[10px] text-muted-foreground/70"
              data-testid="recommender-engine-capability-summary"
            >
              Capability: {describeReasoningCapability(selectedOption.capability)}
              {selectedOption.capability.kind === "effort_levels"
                ? ` · ${getEffectiveReasoningLevels(selectedOption.capability).length} options`
                : ""}
            </p>
          ) : null}
        </div>

        {/* Test button + quick stats */}
        <div className="flex flex-col items-stretch gap-2 rounded-md border border-border/60 px-3 py-3 lg:items-end lg:justify-end">
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => void runTest()}
            disabled={testing || !selectedOption || status.kind === "unavailable"}
            data-testid="recommender-engine-test-button"
          >
            {testing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <FlaskConical className="size-3.5" />
            )}
            Test recommender engine
          </Button>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/80">
            <Plug className="size-3" />
            <span data-testid="recommender-engine-candidate-count">
              {candidatePoolSize} candidate{candidatePoolSize === 1 ? "" : "s"} available
            </span>
          </div>
        </div>
      </div>

      {/* Status detail panel — always rendered so users can read WHY
          the engine is unavailable. */}
      <div
        className={cn("mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-xs", statusBg)}
        data-testid="recommender-engine-status-detail"
      >
        {statusIcon}
        <div className="min-w-0 flex-1">
          <div className="font-medium">
            {status.kind === "available"
              ? "Engine is reachable."
              : status.kind === "test_pass"
                ? "Test call succeeded."
                : status.kind === "test_fail"
                  ? "Test call failed."
                  : status.detail}
          </div>
          {status.kind !== "unavailable" && (
            <div className="mt-0.5 text-[11px] opacity-80">{status.detail}</div>
          )}
        </div>
      </div>

      {/* Fallback engine model + reasoning. Single user-configurable
          model tried right after the primary engine fails. Optional
          ("No fallback" = use the deterministic Codex → MiniMax →
          OpenAI API chain unchanged). */}
      <div
        className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
        data-testid="recommender-engine-fallback"
      >
        {/* Fallback engine model picker */}
        <div className="rounded-md border border-border/60 px-3 py-3">
          <Label htmlFor="recommender-engine-fallback-model">Fallback engine model</Label>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Optional. Tried right after the primary engine fails and before the deterministic Codex
            → MiniMax → OpenAI API defaults. Leave on “No fallback” to keep the default
            subscription-first chain.
          </p>
          <select
            id="recommender-engine-fallback-model"
            data-testid="router-settings-normal-chat-recommender-fallback-model"
            value={fallbackModelId ?? ""}
            onChange={(e) => onFallbackModelChange(e.target.value === "" ? null : e.target.value)}
            className="border-input bg-background mt-2 flex h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none"
          >
            <option value="">No fallback (use deterministic defaults)</option>
            {fallbackModelId && !fallbackOptions.some((o) => o.modelId === fallbackModelId) && (
              <option value={fallbackModelId}>
                {fallbackModelId} (current — provider disabled or unknown)
              </option>
            )}
            {fallbackOptions.map((o) => (
              <option key={o.modelId} value={o.modelId}>
                {o.displayLabel} · {billingShortLabel(o.billingSource)}
              </option>
            ))}
          </select>
          {fallbackSelectedOption ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <BillingTag
                billingSource={fallbackSelectedOption.billingSource}
                testId="recommender-engine-fallback-billing"
              />
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                {fallbackSelectedOption.providerId}
              </span>
            </div>
          ) : (
            <p className="mt-2 text-[10px] text-muted-foreground/70">
              No fallback configured — chain is: engine → Codex default → MiniMax → OpenAI API (if
              opted in).
            </p>
          )}
        </div>

        {/* Fallback reasoning / thinking option picker */}
        <div className="rounded-md border border-border/60 px-3 py-3">
          <Label htmlFor="recommender-engine-fallback-thinking">
            Fallback reasoning / thinking
          </Label>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Provider-native value sent verbatim to the fallback model when it is the active
            recommender. Mirrors the primary picker; disabled until you pick a fallback model.
          </p>
          <select
            id="recommender-engine-fallback-thinking"
            data-testid="router-settings-normal-chat-recommender-fallback-reasoning"
            value={fallbackReasoningOption ?? ""}
            onChange={(e) =>
              onFallbackReasoningChange(e.target.value === "" ? null : e.target.value)
            }
            disabled={!fallbackSelectedOption || fallbackReasoningChoices.length === 0}
            className="border-input bg-background mt-2 flex h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none disabled:opacity-60"
          >
            {fallbackReasoningChoices.map((choice, idx) => (
              <option key={`${choice.value}-${idx}`} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
          {fallbackSelectedOption ? (
            <p
              className="mt-2 text-[10px] text-muted-foreground/70"
              data-testid="recommender-engine-fallback-capability-summary"
            >
              Capability: {describeReasoningCapability(fallbackSelectedOption.capability)}
            </p>
          ) : null}
        </div>
      </div>

      {/* Read-only prompt preview. Built by the API route using the
          live registry so the user sees exactly the prompt body the
          recommender is sent. */}
      <PromptPreview preview={promptPreview} />

      {saveError && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div>{saveError}</div>
        </div>
      )}

      <p className="mt-3 text-[11px] text-muted-foreground/70">
        <strong className="font-medium">Loud-failure policy</strong> — if the engine is unavailable
        the recommender does not silently substitute. The chat composer will surface a clear error
        and the candidate pool from Tab C remains empty for that turn.
      </p>
    </section>
  );
};

function billingShortLabel(billing: "subscription" | "api_billing"): string {
  return billing === "subscription" ? "Subscription-backed" : "API-billed";
}

/**
 * Read-only prompt preview rendered in the Recommender engine tab.
 * The same builder (`buildNormalChatRecommenderPrompt`) is used by
 * `/api/model/recommend` and `/api/router-settings` so the preview
 * never drifts from what the recommender actually sees. The preview
 * uses representative example values for the dynamic per-message
 * fields (the live prompt is per-send and per-thread).
 */
const PromptPreview: FC<{
  preview: {
    system: string;
    userJsonExample: string;
  } | null;
}> = ({ preview }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"system" | "user" | null>(null);

  /**
   * Re-render `userJsonExample` through `JSON.parse` + `JSON.stringify`
   * so we always show pretty-printed JSON even when the API returns a
   * minified one-liner. Cheap; runs only when the preview changes.
   */
  const prettyUser = useMemo(() => {
    if (!preview) return "";
    try {
      return JSON.stringify(JSON.parse(preview.userJsonExample), null, 2);
    } catch {
      return preview.userJsonExample;
    }
  }, [preview]);

  const onCopy = useCallback(async (which: "system" | "user", text: string) => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
    } catch {
      // Best effort — clipboard write can be denied in some browsers;
      // the user can still select the text manually.
    }
    setCopied(which);
    setTimeout(() => setCopied((cur) => (cur === which ? null : cur)), 1500);
  }, []);

  return (
    <div
      className="mt-4 rounded-md border border-border/60"
      data-testid="recommender-engine-prompt-preview"
    >
      <button
        type="button"
        onClick={() => setOpen((cur) => !cur)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
      >
        <span className="flex items-center gap-2 text-xs font-semibold">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          <Code2 className="size-3.5 text-muted-foreground/70" aria-hidden />
          Prompt the recommender engine is using
        </span>
        <span className="text-[10px] text-muted-foreground/70">
          {open ? "Hide" : "Show"} · read-only
        </span>
      </button>
      {open ? (
        <div className="border-t border-border/60 p-3">
          {!preview ? (
            <p className="text-[11px] text-muted-foreground/70">Loading prompt preview…</p>
          ) : (
            <div className="grid gap-3">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                    System prompt
                  </span>
                  <button
                    type="button"
                    onClick={() => void onCopy("system", preview.system)}
                    className="rounded border border-border/60 bg-background px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/40"
                    data-testid="recommender-engine-prompt-copy-system"
                  >
                    {copied === "system" ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre
                  className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-muted/20 p-2 font-mono text-[11px] leading-snug"
                  data-testid="recommender-engine-prompt-system"
                >
                  {preview.system}
                </pre>
              </div>
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                    User prompt (JSON, example values)
                  </span>
                  <button
                    type="button"
                    onClick={() => void onCopy("user", prettyUser)}
                    className="rounded border border-border/60 bg-background px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/40"
                    data-testid="recommender-engine-prompt-copy-user"
                  >
                    {copied === "user" ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre
                  className="mt-1 max-h-72 overflow-auto whitespace-pre rounded border border-border/60 bg-muted/20 p-2 font-mono text-[11px] leading-snug"
                  data-testid="recommender-engine-prompt-user"
                >
                  {prettyUser}
                </pre>
                <p className="mt-1 text-[10px] text-muted-foreground/70">
                  Built with the live registry (representative message + current chat model). The
                  live prompt is dynamic per send.
                </p>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
};

void Input;
