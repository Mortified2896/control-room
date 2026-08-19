"use client";

import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  FlaskConical,
  Info,
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
  getProviderNativeOptionChoices,
  UNKNOWN_REASONING_CAPABILITY,
} from "@/lib/providers/capability";

/**
 * Tab B — Recommender engine (two-lane architecture).
 *
 * Router/recommender lane selection may be deterministic by prompt/context
 * token count. There are two recommender lanes:
 *
 *   1. Default / lower-cost lane
 *      - Used when request token estimate is below the configured threshold.
 *      - Has its own primary recommender engine.
 *      - Has its own paired fallback recommender engine.
 *
 *   2. Long-prompt lane
 *      - Used when request token estimate is at or above the configured threshold.
 *      - Has its own primary recommender engine.
 *      - Has its own paired fallback recommender engine.
 *
 * IMPORTANT:
 *   - The token threshold chooses the recommender lane only.
 *   - The token threshold must NOT directly choose the execution model.
 *   - The chosen recommender engine still chooses the execution model and
 *     reasoning level.
 *   - Fallback is paired per lane.
 *   - No hidden third fallback.
 *   - No deterministic execution-model routing.
 *
 * These are recommender engines, not execution defaults. The selected
 * lane's recommender chooses the execution model. If the selected lane's
 * primary and fallback both fail, recommendation blocks loudly.
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

export type RecommenderEngineTabProps = {
  registry: ReadonlyArray<EffectiveRegistryModelDto>;
  /** Currently-selected engine model id for the default lane. */
  defaultLaneModelId: string;
  /** Currently-selected engine reasoning/thinking option for the default lane. */
  defaultLaneReasoningOption: string;
  /** Optional paired fallback model id for the default lane. `null` = no fallback. */
  defaultLaneFallbackModelId: string | null;
  /** Reasoning level for the default lane fallback model. `null` when no fallback. */
  defaultLaneFallbackReasoningOption: string | null;
  /** Token count past which the long-prompt lane is used. */
  tokenThreshold: string;
  /** Currently-selected engine model id for the long-prompt lane. */
  longPromptLaneModelId: string;
  /** Currently-selected engine reasoning/thinking option for the long-prompt lane. */
  longPromptLaneReasoningOption: string;
  /** Optional paired fallback model id for the long-prompt lane. `null` = no fallback. */
  longPromptLaneFallbackModelId: string | null;
  /** Reasoning level for the long-prompt lane fallback model. `null` when no fallback. */
  longPromptLaneFallbackReasoningOption: string | null;
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
   * pick from given the current Tab C settings.
   */
  candidatePoolSize: number;
  // ===== Change handlers =====
  onDefaultLaneModelChange: (modelId: string) => void;
  onDefaultLaneReasoningChange: (option: string) => void;
  onDefaultLaneFallbackModelChange: (modelId: string | null) => void;
  onDefaultLaneFallbackReasoningChange: (option: string | null) => void;
  onTokenThresholdChange: (value: string) => void;
  onLongPromptLaneModelChange: (modelId: string) => void;
  onLongPromptLaneReasoningChange: (option: string) => void;
  onLongPromptLaneFallbackModelChange: (modelId: string | null) => void;
  onLongPromptLaneFallbackReasoningChange: (option: string | null) => void;
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
    // Skip openai_api when the user has not opted in — API-billed models
    // are not used as recommender unless explicitly approved.
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
 * Derive the pill we render next to the engine model picker.
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

function billingShortLabel(billing: "subscription" | "api_billing"): string {
  return billing === "subscription" ? "Subscription-backed" : "API-billed";
}

/**
 * Read-only prompt preview rendered in the Recommender engine tab.
 */
const PromptPreview: FC<{
  preview: {
    system: string;
    userJsonExample: string;
  } | null;
}> = ({ preview }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"system" | "user" | null>(null);

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
      // Best effort.
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

/**
 * Single-lane engine picker (model + reasoning + optional fallback).
 */
const LanePicker: FC<{
  label: string;
  helpText: string;
  modelId: string;
  reasoningOption: string;
  fallbackModelId: string | null;
  fallbackReasoningOption: string | null;
  options: ReadonlyArray<EngineOption>;
  selectedOption: EngineOption | undefined;
  fallbackSelectedOption: EngineOption | null;
  reasoningChoices: ReadonlyArray<{ value: string; label: string }>;
  fallbackReasoningChoices: ReadonlyArray<{ value: string; label: string }>;
  allowOpenAiApiRouter: boolean;
  registry: ReadonlyArray<EffectiveRegistryModelDto>;
  candidatePoolSize: number;
  status: EngineStatus;
  onModelChange: (modelId: string) => void;
  onReasoningChange: (option: string) => void;
  onFallbackModelChange: (modelId: string | null) => void;
  onFallbackReasoningChange: (option: string | null) => void;
  laneTestId: string;
}> = ({
  label,
  helpText,
  modelId,
  reasoningOption,
  fallbackModelId,
  fallbackReasoningOption,
  options,
  selectedOption,
  fallbackSelectedOption,
  reasoningChoices,
  fallbackReasoningChoices,
  allowOpenAiApiRouter,
  registry,
  candidatePoolSize,
  status,
  onModelChange,
  onReasoningChange,
  onFallbackModelChange,
  onFallbackReasoningChange,
  laneTestId,
}) => {
  const statusBg = (() => {
    if (status.kind === "available" || status.kind === "test_pass")
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    if (status.kind === "test_fail")
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    return "border-destructive/40 bg-destructive/10 text-destructive";
  })();

  const statusIcon = (() => {
    if (status.kind === "available") return <CheckCircle2 className="size-3 shrink-0" />;
    if (status.kind === "test_pass") return <CheckCircle2 className="size-3 shrink-0" />;
    if (status.kind === "test_fail") return <AlertTriangle className="size-3 shrink-0" />;
    return <XCircle className="size-3 shrink-0" />;
  })();

  return (
    <div className="rounded-md border border-border/60">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border/60 bg-muted/30 px-3 py-2">
        <div>
          <h3 className="text-xs font-semibold">{label}</h3>
          <p className="mt-0.5 text-[10px] text-muted-foreground">{helpText}</p>
        </div>
        <div
          data-testid={`${laneTestId}-status`}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[10px]",
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

      <div className="p-3">
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Primary engine model */}
          <div>
            <Label htmlFor={`${laneTestId}-model`}>Primary recommender engine</Label>
            <select
              id={`${laneTestId}-model`}
              data-testid={`${laneTestId}-model`}
              value={modelId}
              onChange={(e) => onModelChange(e.target.value)}
              className="border-input bg-background mt-1 flex h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none"
              aria-invalid={status.kind === "unavailable"}
            >
              {!options.some((o) => o.modelId === modelId) && (
                <option value={modelId}>
                  {modelId} (current — provider disabled or unknown)
                </option>
              )}
              {options.map((o) => (
                <option key={o.modelId} value={o.modelId}>
                  {o.displayLabel} · {billingShortLabel(o.billingSource)}
                </option>
              ))}
            </select>
            {selectedOption ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <BillingTag billingSource={selectedOption.billingSource} testId={`${laneTestId}-billing`} />
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                  {selectedOption.providerId}
                </span>
              </div>
            ) : null}
          </div>

          {/* Primary reasoning */}
          <div>
            <Label htmlFor={`${laneTestId}-reasoning`}>Primary reasoning / thinking</Label>
            <select
              id={`${laneTestId}-reasoning`}
              data-testid={`${laneTestId}-reasoning`}
              value={reasoningOption}
              onChange={(e) => onReasoningChange(e.target.value)}
              disabled={!selectedOption || reasoningChoices.length === 0}
              className="border-input bg-background mt-1 flex h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none disabled:opacity-60"
            >
              {reasoningChoices.map((choice, idx) => (
                <option key={`${choice.value}-${idx}`} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>

          {/* Fallback engine model */}
          <div>
            <Label htmlFor={`${laneTestId}-fallback-model`}>Fallback recommender engine</Label>
            <select
              id={`${laneTestId}-fallback-model`}
              data-testid={`${laneTestId}-fallback-model`}
              value={fallbackModelId ?? ""}
              onChange={(e) => {
                const nextModelId = e.target.value === "" ? null : e.target.value;
                onFallbackModelChange(nextModelId);

                if (nextModelId === null) {
                  onFallbackReasoningChange(null);
                  return;
                }

                const nextOption = options.find((o) => o.modelId === nextModelId);
                const nextChoices = nextOption
                  ? getProviderNativeOptionChoices(nextOption.capability)
                  : [];
                const currentStillValid =
                  fallbackReasoningOption !== null &&
                  nextChoices.some((choice) => choice.value === fallbackReasoningOption);
                onFallbackReasoningChange(
                  currentStillValid ? fallbackReasoningOption : (nextChoices[0]?.value ?? null),
                );
              }}
              className="border-input bg-background mt-1 flex h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none"
            >
              <option value="">No fallback</option>
              {fallbackModelId && !options.some((o) => o.modelId === fallbackModelId) && (
                <option value={fallbackModelId}>
                  {fallbackModelId} (current — provider disabled or unknown)
                </option>
              )}
              {options.map((o) => (
                <option key={o.modelId} value={o.modelId}>
                  {o.displayLabel} · {billingShortLabel(o.billingSource)}
                </option>
              ))}
            </select>
            {fallbackSelectedOption ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <BillingTag
                  billingSource={fallbackSelectedOption.billingSource}
                  testId={`${laneTestId}-fallback-billing`}
                />
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                  {fallbackSelectedOption.providerId}
                </span>
              </div>
            ) : (
              <p className="mt-1 text-[10px] text-muted-foreground/70">
                No fallback — if primary fails, recommendation blocks.
              </p>
            )}
          </div>

          {/* Fallback reasoning */}
          <div>
            <Label htmlFor={`${laneTestId}-fallback-reasoning`}>Fallback reasoning / thinking</Label>
            <select
              id={`${laneTestId}-fallback-reasoning`}
              data-testid={`${laneTestId}-fallback-reasoning`}
              value={fallbackReasoningOption ?? ""}
              onChange={(e) =>
                onFallbackReasoningChange(e.target.value === "" ? null : e.target.value)
              }
              disabled={!fallbackSelectedOption || fallbackReasoningChoices.length === 0}
              className="border-input bg-background mt-1 flex h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none disabled:opacity-60"
            >
              {fallbackReasoningChoices.map((choice, idx) => (
                <option key={`${choice.value}-${idx}`} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
};

export const RecommenderEngineTab: FC<RecommenderEngineTabProps> = ({
  registry,
  defaultLaneModelId,
  defaultLaneReasoningOption,
  defaultLaneFallbackModelId,
  defaultLaneFallbackReasoningOption,
  tokenThreshold,
  longPromptLaneModelId,
  longPromptLaneReasoningOption,
  longPromptLaneFallbackModelId,
  longPromptLaneFallbackReasoningOption,
  allowOpenAiApiRouter,
  engineOptions,
  candidatePoolSize,
  onDefaultLaneModelChange,
  onDefaultLaneReasoningChange,
  onDefaultLaneFallbackModelChange,
  onDefaultLaneFallbackReasoningChange,
  onTokenThresholdChange,
  onLongPromptLaneModelChange,
  onLongPromptLaneReasoningChange,
  onLongPromptLaneFallbackModelChange,
  onLongPromptLaneFallbackReasoningChange,
  promptPreview,
  onTestEngine,
  saveError = null,
  testId = "router-settings-section-recommender-engine",
}) => {
  const options = useMemo<ReadonlyArray<EngineOption>>(
    () => engineOptions ?? buildDefaultEngineOptions(registry, allowOpenAiApiRouter),
    [registry, engineOptions, allowOpenAiApiRouter],
  );

  // Default lane selected option
  const defaultSelectedOption = useMemo(() => {
    const direct = options.find((o) => o.modelId === defaultLaneModelId);
    if (direct) return direct;
    return {
      modelId: defaultLaneModelId,
      displayLabel: `${defaultLaneModelId} (current — provider disabled or unknown)`,
      providerLabel: "Unknown",
      providerId: "openai" as const,
      billingSource: "api_billing" as const,
      capability: UNKNOWN_REASONING_CAPABILITY,
    };
  }, [options, defaultLaneModelId]);

  // Long-prompt lane selected option
  const longPromptSelectedOption = useMemo(() => {
    const direct = options.find((o) => o.modelId === longPromptLaneModelId);
    if (direct) return direct;
    return {
      modelId: longPromptLaneModelId,
      displayLabel: `${longPromptLaneModelId} (current — provider disabled or unknown)`,
      providerLabel: "Unknown",
      providerId: "openai" as const,
      billingSource: "api_billing" as const,
      capability: UNKNOWN_REASONING_CAPABILITY,
    };
  }, [options, longPromptLaneModelId]);

  // Default lane reasoning choices
  const defaultReasoningChoices = useMemo(
    () =>
      defaultSelectedOption
        ? getProviderNativeOptionChoices(defaultSelectedOption.capability)
        : [{ value: "", label: "Pick an engine model" }],
    [defaultSelectedOption],
  );

  // Long-prompt lane reasoning choices
  const longPromptReasoningChoices = useMemo(
    () =>
      longPromptSelectedOption
        ? getProviderNativeOptionChoices(longPromptSelectedOption.capability)
        : [{ value: "", label: "Pick an engine model" }],
    [longPromptSelectedOption],
  );

  // Default lane fallback
  const defaultFallbackSelectedOption = useMemo<EngineOption | null>(() => {
    if (!defaultLaneFallbackModelId) return null;
    const direct = options.find((o) => o.modelId === defaultLaneFallbackModelId);
    if (direct) return direct;
    return {
      modelId: defaultLaneFallbackModelId,
      displayLabel: `${defaultLaneFallbackModelId} (current — provider disabled or unknown)`,
      providerLabel: "Unknown",
      providerId: "openai" as const,
      billingSource: "api_billing" as const,
      capability: UNKNOWN_REASONING_CAPABILITY,
    };
  }, [options, defaultLaneFallbackModelId]);

  const defaultFallbackReasoningChoices = useMemo(
    () =>
      defaultFallbackSelectedOption
        ? getProviderNativeOptionChoices(defaultFallbackSelectedOption.capability)
        : [{ value: "", label: "Pick a fallback model" }],
    [defaultFallbackSelectedOption],
  );

  // Long-prompt lane fallback
  const longPromptFallbackSelectedOption = useMemo<EngineOption | null>(() => {
    if (!longPromptLaneFallbackModelId) return null;
    const direct = options.find((o) => o.modelId === longPromptLaneFallbackModelId);
    if (direct) return direct;
    return {
      modelId: longPromptLaneFallbackModelId,
      displayLabel: `${longPromptLaneFallbackModelId} (current — provider disabled or unknown)`,
      providerLabel: "Unknown",
      providerId: "openai" as const,
      billingSource: "api_billing" as const,
      capability: UNKNOWN_REASONING_CAPABILITY,
    };
  }, [options, longPromptLaneFallbackModelId]);

  const longPromptFallbackReasoningChoices = useMemo(
    () =>
      longPromptFallbackSelectedOption
        ? getProviderNativeOptionChoices(longPromptFallbackSelectedOption.capability)
        : [{ value: "", label: "Pick a fallback model" }],
    [longPromptFallbackSelectedOption],
  );

  const [testState, setTestState] = useState<EngineStatus | null>(null);
  const [testing, setTesting] = useState(false);

  // Default lane status (using default lane primary as the test target)
  const defaultLaneStatus = useMemo(
    () =>
      computeEngineStatus({
        selected: defaultSelectedOption,
        registry,
        candidatePoolSize,
        allowOpenAiApiRouter,
        testResult: testState,
      }),
    [defaultSelectedOption, registry, candidatePoolSize, allowOpenAiApiRouter, testState],
  );

  // Long-prompt lane status (using long-prompt lane primary as the test target)
  const longPromptLaneStatus = useMemo(
    () =>
      computeEngineStatus({
        selected: longPromptSelectedOption,
        registry,
        candidatePoolSize,
        allowOpenAiApiRouter,
        testResult: testState,
      }),
    [longPromptSelectedOption, registry, candidatePoolSize, allowOpenAiApiRouter, testState],
  );

  // Reset test state when any engine model changes
  useEffect(() => {
    setTestState(null);
  }, [
    defaultLaneModelId,
    defaultLaneReasoningOption,
    defaultLaneFallbackModelId,
    defaultLaneFallbackReasoningOption,
    longPromptLaneModelId,
    longPromptLaneReasoningOption,
    longPromptLaneFallbackModelId,
    longPromptLaneFallbackReasoningOption,
  ]);

  const runTest = useCallback(async () => {
    setTesting(true);
    try {
      const result = await onTestEngine();
      setTestState(result);
    } finally {
      setTesting(false);
    }
  }, [onTestEngine]);

  const overallStatus = defaultLaneStatus;

  const statusBg = (() => {
    if (overallStatus.kind === "available" || overallStatus.kind === "test_pass")
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    if (overallStatus.kind === "test_fail")
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    return "border-destructive/40 bg-destructive/10 text-destructive";
  })();

  const statusIcon = (() => {
    if (overallStatus.kind === "available") return <CheckCircle2 className="size-3.5 shrink-0" />;
    if (overallStatus.kind === "test_pass") return <CheckCircle2 className="size-3.5 shrink-0" />;
    if (overallStatus.kind === "test_fail") return <AlertTriangle className="size-3.5 shrink-0" />;
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
            Two recommender lanes select which engine pair to consult. The token threshold chooses
            the lane only — the selected engine then chooses the execution model.
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
            {overallStatus.kind === "available"
              ? "Available"
              : overallStatus.kind === "test_pass"
                ? "Test passed"
                : overallStatus.kind === "test_fail"
                  ? "Test failed"
                  : "Unavailable"}
          </span>
        </div>
      </div>

      {/* Token threshold */}
      <div className="mt-4 rounded-md border border-border/60 bg-muted/20 p-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="token-threshold" className="text-xs font-medium">
              Token threshold for long-prompt lane
            </Label>
            <Input
              id="token-threshold"
              type="number"
              min={1000}
              step={1000}
              value={tokenThreshold}
              onChange={(e) => onTokenThresholdChange(e.target.value)}
              data-testid="router-settings-token-threshold"
              className="h-8 w-32 text-sm"
            />
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Info className="size-3" />
            <span>
              Below this: default lane. At or above: long-prompt lane. This chooses the recommender
              lane only, not the execution model.
            </span>
          </div>
        </div>
      </div>

      {/* Two lanes */}
      <div className="mt-4 space-y-4">
        {/* Default / lower-cost lane */}
        <LanePicker
          label="A · Default / lower-cost recommender lane"
          helpText="Used below the token threshold."
          modelId={defaultLaneModelId}
          reasoningOption={defaultLaneReasoningOption}
          fallbackModelId={defaultLaneFallbackModelId}
          fallbackReasoningOption={defaultLaneFallbackReasoningOption}
          options={options}
          selectedOption={defaultSelectedOption}
          fallbackSelectedOption={defaultFallbackSelectedOption}
          reasoningChoices={defaultReasoningChoices}
          fallbackReasoningChoices={defaultFallbackReasoningChoices}
          allowOpenAiApiRouter={allowOpenAiApiRouter}
          registry={registry}
          candidatePoolSize={candidatePoolSize}
          status={defaultLaneStatus}
          onModelChange={onDefaultLaneModelChange}
          onReasoningChange={onDefaultLaneReasoningChange}
          onFallbackModelChange={onDefaultLaneFallbackModelChange}
          onFallbackReasoningChange={onDefaultLaneFallbackReasoningChange}
          laneTestId="router-settings-default-lane"
        />

        {/* Long-prompt lane */}
        <LanePicker
          label="B · Long-prompt recommender lane"
          helpText="Used at or above the token threshold."
          modelId={longPromptLaneModelId}
          reasoningOption={longPromptLaneReasoningOption}
          fallbackModelId={longPromptLaneFallbackModelId}
          fallbackReasoningOption={longPromptLaneFallbackReasoningOption}
          options={options}
          selectedOption={longPromptSelectedOption}
          fallbackSelectedOption={longPromptFallbackSelectedOption}
          reasoningChoices={longPromptReasoningChoices}
          fallbackReasoningChoices={longPromptFallbackReasoningChoices}
          allowOpenAiApiRouter={allowOpenAiApiRouter}
          registry={registry}
          candidatePoolSize={candidatePoolSize}
          status={longPromptLaneStatus}
          onModelChange={onLongPromptLaneModelChange}
          onReasoningChange={onLongPromptLaneReasoningChange}
          onFallbackModelChange={onLongPromptLaneFallbackModelChange}
          onFallbackReasoningChange={onLongPromptLaneFallbackReasoningChange}
          laneTestId="router-settings-long-prompt-lane"
        />
      </div>

      {/* Status detail panel */}
      <div
        className={cn("mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-xs", statusBg)}
        data-testid="recommender-engine-status-detail"
      >
        {statusIcon}
        <div className="min-w-0 flex-1">
          <div className="font-medium">
            {overallStatus.kind === "available"
              ? "Engine is reachable."
              : overallStatus.kind === "test_pass"
                ? "Test call succeeded."
                : overallStatus.kind === "test_fail"
                  ? "Test call failed."
                  : overallStatus.detail}
          </div>
          {overallStatus.kind !== "unavailable" && (
            <div className="mt-0.5 text-[11px] opacity-80">{overallStatus.detail}</div>
          )}
        </div>
      </div>

      {/* Test button */}
      <div className="mt-3 flex items-center gap-3">
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => void runTest()}
          disabled={testing || !defaultSelectedOption || overallStatus.kind === "unavailable"}
          data-testid="recommender-engine-test-button"
        >
          {testing ? <Loader2 className="size-3.5 animate-spin" /> : <FlaskConical className="size-3.5" />}
          Test recommender engine
        </Button>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/80">
          <Plug className="size-3" />
          <span data-testid="recommender-engine-candidate-count">
            {candidatePoolSize} candidate{candidatePoolSize === 1 ? "" : "s"} available
          </span>
        </div>
      </div>

      {/* Prompt preview */}
      <PromptPreview preview={promptPreview} />

      {saveError && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div>{saveError}</div>
        </div>
      )}

      {/* Explanatory copy */}
      <div className="mt-4 rounded-md border border-blue-500/30 bg-blue-500/10 p-3">
        <h4 className="text-[11px] font-semibold text-blue-700 dark:text-blue-300">
          How recommender engines work
        </h4>
        <ul className="mt-2 space-y-1 text-[10px] text-muted-foreground">
          <li>• These are recommender engines, not execution defaults.</li>
          <li>• The selected lane&apos;s recommender chooses the execution model.</li>
          <li>
            • If the selected lane&apos;s primary and fallback both fail, recommendation blocks
            loudly.
          </li>
          <li>• No hidden Codex/MiniMax/OpenAI fallback is used.</li>
          <li>• The token threshold chooses the recommender lane only.</li>
        </ul>
      </div>

      <p className="mt-3 text-[11px] text-muted-foreground/70">
        <strong className="font-medium">Loud-failure policy</strong> — if the engine is unavailable
        the recommender does not silently substitute. The chat composer will surface a clear error
        and the candidate pool from Tab C remains empty for that turn.
      </p>
    </section>
  );
};
