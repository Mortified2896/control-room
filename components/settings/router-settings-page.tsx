"use client";

import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Loader2, RotateCcw, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

import type { RouterFailureBehavior, RouterSettings } from "@/lib/router/schema";
import { CODEX_CATALOG_MODELS } from "@/lib/providers/codex-catalog";
import type { ReasoningCapability } from "@/lib/providers/capability";
import { hasReasoningControls } from "@/lib/providers/capability";

import { DiscoverySection } from "./router-settings/discovery-section";
import { ManualChatPickerTab } from "./router-settings/manual-chat-picker-tab";
import { RecommenderEngineTab } from "./router-settings/recommender-engine-tab";
import { RecommenderCandidatesTab } from "./router-settings/recommender-candidates-tab";
import type { EffectiveRegistryModelDto } from "./router-settings/types";

/**
 * `/settings/router` orchestrator.
 *
 * Post-split page structure:
 *
 *   - Discovery section (kept, same as before)
 *   - Tab A · Manual chat picker          (saves immediately)
 *   - Tab B · Recommender engine          (batches into Save)
 *   - Tab C · Recommender candidates      (batches into Save)
 *
 * The page still loads `/api/router-settings` to populate the
 * EffectiveRegistry (since the discovery snapshot + per-model
 * capabilities live there), but Tab A persists through
 * `/api/model-selector-prefs` while Tabs B/C persist through
 * `/api/router-settings`.
 *
 * This refactor preserves all the legacy test IDs (`registry-row-*`,
 * `registry-manual-toggle-*`, `registry-reasoning-*`, `registry-tower-*`,
 * `registry-recommender-toggle-*`, `router-settings-save`,
 * `router-settings-normal-chat-recommender-model`,
 * `router-settings-normal-chat-recommender-reasoning`,
 * `router-settings-recommender-allowlist-*`) so the existing e2e suite
 * keeps working without churn.
 *
 * What changed visually:
 *   - The single unified registry table is gone. Its columns are split
 *     across Tab A (Manual picker column only, with billing/status
 *     tags) and Tab C (Allow recommender + Allowed reasoning options).
 *   - Section labels changed from "Discovery / Model registry / Router
 *     Global Settings" to "Discovery / Manual chat picker /
 *     Recommender engine / Recommender candidates".
 *   - Removed the "Tier" column and STANDARD/EXPENSIVE pills.
 *
 * What did NOT change:
 *   - Backend schema — `RouterSettings` still owns the engine + candidate
 *     fields and the model selector prefs live in their own row.
 *   - The Save button persists the same fields as before (engine +
 *     candidate pool + A/B router knobs).
 *   - The Router A/B knobs (routerModelId, failureBehavior, threshold,
 *     allowExpensiveModels, allowLongPromptWhenExpensive) keep their
 *     current API surface. We do not solve Router A/B in this pass.
 */

type SettingsProviderId = "openai" | "minimax" | "codex";

type EffectiveDiscoveryDto = {
  modelIds: ReadonlyArray<string>;
  fetchedAt: string | null;
  httpStatus: number | null;
  source: "openai" | "fake" | "fallback";
  rawCount: number | null;
  errorMessage: string | null;
  ageMs: number | null;
  isStale: boolean;
};

type MiniMaxDiscoveryDto = EffectiveDiscoveryDto & { source: "minimax" | "fallback" };

type RouterSettingsDto = {
  effective: RouterSettings;
  defaults: RouterSettings;
  configured: boolean;
  effectiveRegistry: {
    models: ReadonlyArray<{
      providerId: SettingsProviderId;
      providerLabel: string;
      modelId: string;
      displayLabel: string;
      configured: boolean;
      available: boolean;
      stale: boolean;
      reasoningCapability: ReasoningCapability;
      supportsReasoning: boolean;
      supportedReasoningLevels: ReadonlyArray<string>;
      tier: "standard" | "expensive" | "unknown";
      usableForChat: boolean;
      manualSelectorVisible: boolean;
      manuallyOverridden: boolean;
      routerEligible: boolean;
      capabilities: {
        reasoning: boolean;
        vision: boolean;
        images: boolean;
        functionCalling: boolean;
        structuredOutput: boolean;
        streaming: boolean;
      };
      provenance: "local_meta" | "discovered_only" | "fake" | "stale" | "env_static";
    }>;
    defaults: { manualModelId: string | null; reasoningLevel: string };
    counts: {
      discovered: number;
      discoveredConfigured: number;
      discoveredUnclassified: number;
      configuredAvailable: number;
      stale: number;
      manualSelectorVisible: number;
      routerEligible: number;
    };
    discovery: EffectiveDiscoveryDto;
    minimaxDiscovery: MiniMaxDiscoveryDto;
    selectorPrefs: Record<string, { visible: boolean }>;
    fakeMode: boolean;
  };
  normalChatRecommenderPrompt: {
    system: string;
    user: string;
    userJsonExample: string;
  };
};

type FieldError = { field: string; message: string };

type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "error"; message: string };

type RefreshStatus =
  | { kind: "idle" }
  | { kind: "refreshing" }
  | {
      kind: "refreshed";
      at: number;
      modelCount: number;
      codexModelCount: number;
      minimaxModelCount: number;
      source: "openai" | "fake" | "minimax" | "cache_fresh";
    }
  | { kind: "refresh_error"; at: number; message: string };

/**
 * Reduced view of the registry rows the new tabs consume. We map the
 * verbose `effectiveRegistry.models[]` from the API into this slimmer
 * shape so the tab components stay readable.
 */
function toRow(
  entry: RouterSettingsDto["effectiveRegistry"]["models"][number],
): EffectiveRegistryModelDto {
  return {
    providerId: entry.providerId,
    providerLabel: entry.providerLabel,
    modelId: entry.modelId,
    displayLabel: entry.displayLabel,
    configured: entry.configured,
    available: entry.available,
    stale: entry.stale,
    reasoningCapability: entry.reasoningCapability,
    supportedReasoningLevels: entry.supportedReasoningLevels,
    billingSource: entry.providerId === "openai" ? "api_billing" : "subscription",
  };
}

function comboKey(modelId: string, reasoningLevel: string): string {
  return `${modelId}|${reasoningLevel}`;
}

type FormState = {
  /** Editor for the engine model id. Persists via /api/router-settings. */
  normalChatRecommenderModelId: string;
  /** Editor for the engine reasoning/thinking option. Persists via /api/router-settings. */
  normalChatRecommenderReasoningLevel: string;
  /**
   * Optional user-configured single-model fallback for the recommender
   * engine. `null` = no fallback (chain uses deterministic Codex →
   * MiniMax → OpenAI API defaults). Non-null = tried right after the
   * primary engine fails.
   */
  normalChatRecommenderFallbackModelId: string | null;
  /**
   * Reasoning / thinking level for the fallback model. `null` when no
   * fallback is configured (the validator enforces this invariant).
   */
  normalChatRecommenderFallbackReasoningLevel: string | null;
  /** A/B router model id (legacy Router A/B knob, persists via /api/router-settings). */
  routerModelId: string;
  /** Failure behavior of the Side B A/B router (legacy). */
  failureBehavior: RouterFailureBehavior;
  /** Long-prompt threshold for the legacy Side B guard. */
  longPromptThresholdChars: string;
  /** Per-row (model, reasoning) option allowlist for Tab C. */
  allowedComboKeys: Set<string>;
  /** Model allowlist for Tab C; null = no restriction. */
  normalChatRecommenderAllowedModels: Set<string> | null;
};

function initialForm(dto: RouterSettingsDto): FormState {
  return {
    normalChatRecommenderModelId: dto.effective.normalChatRecommenderModelId,
    normalChatRecommenderReasoningLevel: dto.effective.normalChatRecommenderReasoningLevel,
    normalChatRecommenderFallbackModelId:
      dto.effective.normalChatRecommenderFallbackModelId ?? null,
    normalChatRecommenderFallbackReasoningLevel:
      dto.effective.normalChatRecommenderFallbackReasoningLevel ?? null,
    routerModelId: dto.effective.routerModelId,
    failureBehavior: dto.effective.failureBehavior,
    longPromptThresholdChars:
      dto.effective.longPromptThresholdChars === 0
        ? ""
        : String(dto.effective.longPromptThresholdChars),
    allowedComboKeys: new Set(
      dto.effective.allowedCombos.map((c) => comboKey(c.modelId, c.reasoningLevel)),
    ),
    normalChatRecommenderAllowedModels:
      dto.effective.normalChatRecommenderAllowedModels === null
        ? null
        : new Set(dto.effective.normalChatRecommenderAllowedModels),
  };
}

function formToPayload(form: FormState): {
  payload: Record<string, unknown>;
  clientErrors: ReadonlyArray<FieldError>;
} {
  const errors: FieldError[] = [];
  const cleanedKeys = [...form.allowedComboKeys];
  if (cleanedKeys.length === 0) {
    errors.push({
      field: "allowedCombos",
      message: "Select at least one (model, reasoning level) combination.",
    });
  }

  let threshold: number | null = null;
  const trimmed = form.longPromptThresholdChars.trim();
  if (trimmed.length === 0) {
    threshold = null;
  } else {
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) {
      errors.push({
        field: "longPromptThresholdChars",
        message: "Long prompt threshold must be 0 or a positive number (or blank).",
      });
    } else {
      threshold = Math.floor(n);
    }
  }

  const allowedCombos = cleanedKeys.map((k) => {
    const [modelId, reasoningLevel] = k.split("|") as [string, string];
    return { modelId, reasoningLevel };
  });

  return {
    payload: {
      // The per-row table in Tab C is the source of truth for "what the
      // router may pick". Keep the legacy global expensive guards open
      // so a hidden persisted false cannot contradict an explicitly
      // enabled row.
      allowExpensiveModels: true,
      allowLongPromptWhenExpensive: true,
      longPromptThresholdChars: threshold,
      routerModelId: form.routerModelId,
      normalChatRecommenderModelId: form.normalChatRecommenderModelId,
      normalChatRecommenderReasoningLevel: form.normalChatRecommenderReasoningLevel,
      // The fallback model + reasoning are user-configurable. We
      // send `null` through unchanged so the user can clear the
      // fallback (the default = no fallback).
      normalChatRecommenderFallbackModelId: form.normalChatRecommenderFallbackModelId,
      normalChatRecommenderFallbackReasoningLevel: form.normalChatRecommenderFallbackReasoningLevel,
      failureBehavior: form.failureBehavior,
      allowedCombos,
      normalChatRecommenderAllowedModels:
        form.normalChatRecommenderAllowedModels === null
          ? null
          : [...form.normalChatRecommenderAllowedModels],
    },
    clientErrors: errors,
  };
}

function hasFormChanged(form: FormState, baseline: FormState): boolean {
  if (form.normalChatRecommenderModelId !== baseline.normalChatRecommenderModelId) return true;
  if (form.normalChatRecommenderReasoningLevel !== baseline.normalChatRecommenderReasoningLevel)
    return true;
  if (form.normalChatRecommenderFallbackModelId !== baseline.normalChatRecommenderFallbackModelId)
    return true;
  if (
    form.normalChatRecommenderFallbackReasoningLevel !==
    baseline.normalChatRecommenderFallbackReasoningLevel
  )
    return true;
  if (form.routerModelId !== baseline.routerModelId) return true;
  if (form.failureBehavior !== baseline.failureBehavior) return true;
  if (form.longPromptThresholdChars !== baseline.longPromptThresholdChars) return true;
  if (form.allowedComboKeys.size !== baseline.allowedComboKeys.size) return true;
  for (const k of form.allowedComboKeys) {
    if (!baseline.allowedComboKeys.has(k)) return true;
  }
  if (
    (form.normalChatRecommenderAllowedModels === null) !==
    (baseline.normalChatRecommenderAllowedModels === null)
  ) {
    return true;
  }
  if (form.normalChatRecommenderAllowedModels !== null) {
    const formSet = form.normalChatRecommenderAllowedModels;
    const baseSet = baseline.normalChatRecommenderAllowedModels ?? new Set<string>();
    if (formSet.size !== baseSet.size) return true;
    for (const id of formSet) {
      if (!baseSet.has(id)) return true;
    }
  }
  return false;
}

const ErrorPanel: FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => {
  return (
    <div className="mx-auto flex h-dvh w-full max-w-2xl flex-col items-center justify-center gap-3 p-6 text-center">
      <AlertTriangle className="size-6 text-amber-500" />
      <h1 className="text-base font-semibold">Router Settings unavailable</h1>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCcw className="size-3.5" />
          Retry
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/">
            <ArrowLeft className="size-3.5" />
            Back to chat
          </Link>
        </Button>
      </div>
    </div>
  );
};

const LoadingPanel: FC = () => {
  return (
    <div className="mx-auto flex h-dvh w-full max-w-2xl items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      Loading router settings…
    </div>
  );
};

/**
 * Codex catalog rows are surfaced on the chat picker alongside the
 * registry rows; we want the recommender candidates tab to render them
 * too so users can constrain Codex in the recommender pool. The API
 * already returns Codex rows in `effectiveRegistry.models[]`, so the
 * legacy router-settings-page merged them in. We re-merge here so the
 * new tabs never lose rows between refactors.
 */
function mergeCodexIntoRegistry(
  dto: RouterSettingsDto,
): RouterSettingsDto["effectiveRegistry"]["models"] {
  const existingIds = new Set(dto.effectiveRegistry.models.map((m) => m.modelId));
  const codexRows = CODEX_CATALOG_MODELS.filter((m) => !existingIds.has(`codex:${m.id}`)).map(
    (m) => ({
      providerId: "codex" as const,
      providerLabel: "Codex subscription",
      modelId: `codex:${m.id}`,
      displayLabel: `Codex · ${m.label}`,
      configured: true,
      available: true,
      stale: false,
      reasoningCapability: m.reasoningCapability,
      supportsReasoning: hasReasoningControls(m.reasoningCapability),
      supportedReasoningLevels: (m.reasoningCapability.kind === "effort_levels"
        ? m.reasoningCapability.options.map((o) => o.value)
        : []
      ).slice(),
      tier: m.tier === "expensive" ? ("expensive" as const) : ("standard" as const),
      usableForChat: true,
      manualSelectorVisible: true,
      manuallyOverridden: false,
      routerEligible: false,
      capabilities: {
        reasoning: hasReasoningControls(m.reasoningCapability),
        vision: false,
        images: false,
        functionCalling: false,
        structuredOutput: false,
        streaming: true,
      },
      provenance: "env_static" as const,
    }),
  );
  return [...dto.effectiveRegistry.models, ...codexRows];
}

export const RouterSettingsPage: FC<{
  embedded?: boolean;
  providerFilter?: SettingsProviderId;
}> = ({ embedded = false, providerFilter }) => {
  const [dto, setDto] = useState<RouterSettingsDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [baseline, setBaseline] = useState<FormState | null>(null);
  const [serverErrors, setServerErrors] = useState<ReadonlyArray<FieldError>>([]);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: "idle" });
  const [refreshStatus, setRefreshStatus] = useState<RefreshStatus>({ kind: "idle" });
  const [selectorSaving, setSelectorSaving] = useState<Record<string, boolean>>({});
  const [selectorError, setSelectorError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/router-settings", { cache: "no-store" });
      if (res.status === 503) {
        setLoadError("CONTROL_ROOM_DATABASE_URL is not set. The Settings UI requires Postgres.");
        setDto(null);
        setForm(null);
        setBaseline(null);
        return;
      }
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as RouterSettingsDto;
      setDto(data);
      const next = initialForm(data);
      setForm(next);
      setBaseline(next);
      setServerErrors([]);
      setSaveStatus({ kind: "idle" });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load settings");
      setDto(null);
      setForm(null);
      setBaseline(null);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const rows = useMemo<EffectiveRegistryModelDto[]>(() => {
    if (!dto) return [];
    let entries = mergeCodexIntoRegistry(dto);
    if (providerFilter) {
      entries = entries.filter((e) => e.providerId === providerFilter);
    }
    return entries.map(toRow);
  }, [dto, providerFilter]);

  const selectorPrefs = useMemo(() => dto?.effectiveRegistry.selectorPrefs ?? {}, [dto]);

  /**
   * Server-computed default visibility for a row. Mirrors the
   * merge-time logic in `lib/providers/registry.ts`: configured +
   * available models are visible by default; unconfigured / stale
   * models are hidden by default unless explicitly opted in.
   */
  const defaultVisibleFor = useCallback(
    (entry: EffectiveRegistryModelDto): boolean => {
      const raw = dto?.effectiveRegistry.models.find((m) => m.modelId === entry.modelId);
      return raw?.manualSelectorVisible ?? (entry.configured && entry.available);
    },
    [dto],
  );

  /**
   * Pre-baked engine-options list for Tab B. Engine options include
   *   - every configured Codex row (subscription, never blocked from
   *     being the engine)
   *   - every configured MiniMax row (subscription)
   *   - every configured OpenAI API row (opt-in only — gated behind
   *     `allowOpenAiApiRouter` by the engine-options builder)
   *
   * OpenAI API rows are filtered out when the user has not opted in to
   * `allowOpenAiApiRouter`, so an unselected option cannot accidentally
   * be configured as the engine.
   */
  const engineOptions = useMemo(() => {
    return rows
      .filter((r) => {
        if (!r.configured) return false;
        if (r.providerId === "openai") {
          return dto?.effective.allowOpenAiApiRouter === true;
        }
        return true;
      })
      .map((r) => ({
        modelId: r.modelId,
        displayLabel: r.displayLabel,
        providerLabel: r.providerLabel,
        providerId: r.providerId,
        billingSource: r.billingSource,
        capability: r.reasoningCapability,
      }));
  }, [rows, dto]);

  /**
   * Tab C: per-(model, level) reasoning-cell helpers.
   */
  const toggleRecommenderForModel = useCallback(
    (modelId: string, enabled: boolean) => {
      setForm((prev) => {
        if (!prev) return prev;
        const eligibleRows = rows.filter((r) => r.configured && r.available);
        let next: Set<string> | null;
        if (prev.normalChatRecommenderAllowedModels === null) {
          if (enabled) {
            next = null;
          } else {
            next = new Set<string>();
            for (const r of eligibleRows) {
              if (r.modelId !== modelId) next.add(r.modelId);
            }
          }
        } else {
          next = new Set(prev.normalChatRecommenderAllowedModels);
          if (enabled) next.add(modelId);
          else next.delete(modelId);
          let allIn = next.size >= eligibleRows.length;
          if (allIn) {
            for (const r of eligibleRows) {
              if (!next.has(r.modelId)) {
                allIn = false;
                break;
              }
            }
          }
          if (allIn) next = null;
        }
        return { ...prev, normalChatRecommenderAllowedModels: next };
      });
    },
    [rows],
  );

  const toggleReasoningCombo = useCallback(
    (modelId: string, reasoningLevel: string, enabled: boolean) => {
      setForm((prev) => {
        if (!prev) return prev;
        const next = new Set(prev.allowedComboKeys);
        const k = comboKey(modelId, reasoningLevel);
        if (enabled) next.add(k);
        else next.delete(k);
        return { ...prev, allowedComboKeys: next };
      });
    },
    [],
  );

  const update = useCallback((patch: Partial<FormState>) => {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const onResetDefaults = useCallback(() => {
    if (!dto) return;
    const next = initialForm({ ...dto, effective: dto.defaults });
    setForm(next);
    setServerErrors([]);
    setSaveStatus({ kind: "idle" });
  }, [dto]);

  const onDiscardChanges = useCallback(() => {
    setForm(baseline);
    setServerErrors([]);
    setSaveStatus({ kind: "idle" });
  }, [baseline]);

  const onSave = useCallback(async () => {
    if (!form || !dto) return;
    const { payload, clientErrors } = formToPayload(form);
    if (clientErrors.length > 0) {
      setServerErrors(clientErrors);
      setSaveStatus({ kind: "error", message: "Please fix the highlighted fields." });
      return;
    }
    setServerErrors([]);
    setSaveStatus({ kind: "saving" });
    try {
      const res = await fetch("/api/router-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
          errors?: FieldError[];
          reason?: string;
        } | null;
        if (data?.errors && Array.isArray(data.errors)) {
          setServerErrors(data.errors);
        }
        const message = data?.reason ?? `Save failed (status ${res.status})`;
        setSaveStatus({ kind: "error", message });
        return;
      }
      const data = (await res.json()) as { settings: RouterSettings };
      const fresh = await fetch("/api/router-settings", { cache: "no-store" });
      if (fresh.ok) {
        const freshDto = (await fresh.json()) as RouterSettingsDto;
        setDto(freshDto);
        const next = initialForm(freshDto);
        setForm(next);
        setBaseline(next);
      } else {
        const next = initialForm({ ...dto, effective: data.settings });
        setForm(next);
        setBaseline(next);
      }
      setSaveStatus({ kind: "saved", at: Date.now() });
      void data;
    } catch (err) {
      setSaveStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Save failed",
      });
    }
  }, [form, dto]);

  const onRefreshDiscovery = useCallback(async () => {
    setRefreshStatus({ kind: "refreshing" });
    try {
      const res = await fetch("/api/models-discovery/refresh", {
        method: "POST",
        cache: "no-store",
      });
      if (res.status === 503) {
        setRefreshStatus({
          kind: "refresh_error",
          at: Date.now(),
          message: "DB not configured — cannot persist discovery.",
        });
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `status ${res.status}`);
      }
      const data = (await res.json()) as {
        outcome: {
          kind: "fresh" | "partial_failed" | "failed";
          modelCount: number;
          codexModelCount: number;
          minimaxModelCount: number;
          providers?: Record<string, { kind: string; reason?: string; usedCache?: boolean }>;
        };
      };
      const failed = Object.entries(data.outcome.providers ?? {}).filter(
        ([, provider]) => provider.kind === "failed",
      );
      if (failed.length > 0) {
        setRefreshStatus({
          kind: "refresh_error",
          at: Date.now(),
          message: failed
            .map(
              ([name, provider]) =>
                `${name}: ${provider.reason ?? "refresh failed"}${provider.usedCache ? " (using cache)" : ""}`,
            )
            .join("; "),
        });
      } else {
        setRefreshStatus({
          kind: "refreshed",
          at: Date.now(),
          modelCount: data.outcome.modelCount,
          source: "openai",
          codexModelCount: data.outcome.codexModelCount,
          minimaxModelCount: data.outcome.minimaxModelCount,
        });
      }
      await loadSettings();
    } catch (err) {
      setRefreshStatus({
        kind: "refresh_error",
        at: Date.now(),
        message: err instanceof Error ? err.message : "Refresh failed",
      });
    }
  }, [loadSettings]);

  /**
   * Manual picker persistence (Tab A). Writes the singleton prefs row
   * immediately when the user flips a switch, mirroring the legacy
   * registry-table behavior. The /api/router-settings Save button is
   * NOT responsible for picker changes.
   */
  const onToggleSelectorVisible = useCallback(
    async (modelId: string, visible: boolean) => {
      if (!dto) return;
      const nextPrefs: Record<string, { visible: boolean }> = {
        ...dto.effectiveRegistry.selectorPrefs,
        [modelId]: { visible },
      };
      setDto({ ...dto, effectiveRegistry: { ...dto.effectiveRegistry, selectorPrefs: nextPrefs } });
      setSelectorSaving((s) => ({ ...s, [modelId]: true }));
      setSelectorError(null);
      try {
        const res = await fetch("/api/model-selector-prefs", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preferences: nextPrefs }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            reason?: string;
            errors?: ReadonlyArray<FieldError>;
          } | null;
          throw new Error(body?.reason ?? `status ${res.status}`);
        }
      } catch (err) {
        setDto(dto);
        setSelectorError(err instanceof Error ? err.message : "Save failed");
      } finally {
        setSelectorSaving((s) => ({ ...s, [modelId]: false }));
      }
    },
    [dto],
  );

  /**
   * Bulk action: Show all / Hide all for Tab A. We write the prefs row
   * with the union of all visible / hidden flags.
   */
  const onBulkSetAllVisible = useCallback(
    async (visible: boolean) => {
      if (!dto) return;
      const nextPrefs: Record<string, { visible: boolean }> = {};
      for (const r of rows) {
        nextPrefs[r.modelId] = { visible };
      }
      setDto({ ...dto, effectiveRegistry: { ...dto.effectiveRegistry, selectorPrefs: nextPrefs } });
      setSelectorError(null);
      try {
        const res = await fetch("/api/model-selector-prefs", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preferences: nextPrefs }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { reason?: string } | null;
          throw new Error(body?.reason ?? `status ${res.status}`);
        }
      } catch (err) {
        setDto(dto);
        setSelectorError(err instanceof Error ? err.message : "Save failed");
      }
    },
    [dto, rows],
  );

  // -----------------------------------------------------------------
  // Tab C bulk actions
  // -----------------------------------------------------------------

  const onAllowSubscriptionStandard = useCallback(() => {
    setForm((prev) => {
      if (!prev) return prev;
      // Subscription-backed standard models get auto-included.
      const subscriptionStandard = rows.filter(
        (r) => r.billingSource === "subscription" && r.configured && r.available,
      );
      const explicit = new Set<string>(
        prev.normalChatRecommenderAllowedModels === null
          ? rows.filter((r) => r.configured && r.available).map((r) => r.modelId)
          : [...prev.normalChatRecommenderAllowedModels],
      );
      for (const r of subscriptionStandard) explicit.add(r.modelId);
      // Never set `null` here; explicit Set preserves the user's
      // opt-out semantics for API-billed rows.
      return { ...prev, normalChatRecommenderAllowedModels: explicit };
    });
  }, [rows]);

  const onBlockApiBilled = useCallback(() => {
    setForm((prev) => {
      if (!prev) return prev;
      const explicit = new Set<string>(
        prev.normalChatRecommenderAllowedModels === null
          ? rows.filter((r) => r.configured && r.available).map((r) => r.modelId)
          : [...prev.normalChatRecommenderAllowedModels],
      );
      // API-billed rows must be explicitly opted in to remain in the
      // candidate pool. The bulk action here forces them out so the
      // user can re-add them via the per-row toggle later if needed.
      for (const r of rows) {
        if (r.billingSource === "api_billing") explicit.delete(r.modelId);
      }
      return { ...prev, normalChatRecommenderAllowedModels: explicit };
    });
  }, [rows]);

  const onBlockAll = useCallback(() => {
    setForm((prev) => (prev ? { ...prev, normalChatRecommenderAllowedModels: new Set() } : prev));
  }, []);

  const onAllowAll = useCallback(() => {
    setForm((prev) => (prev ? { ...prev, normalChatRecommenderAllowedModels: null } : prev));
  }, []);

  const onResetSafeDefaults = useCallback(() => {
    setForm((prev) => {
      if (!prev) return prev;
      // Safe defaults = no explicit allowlist + minimal reasoning
      // per-model surface (one low effort option per row).
      return {
        ...prev,
        normalChatRecommenderAllowedModels: null,
        allowedComboKeys: new Set<string>(),
      };
    });
  }, []);

  /**
   * Loud-failure engine smoke-test. Calls /api/model/recommend in a
   * non-mutating way; surfaces the outcome as an `EngineStatus`. We
   * intentionally do NOT fall back to a different engine — loud
   * failure only, per the brief.
   */
  const onTestEngine = useCallback(async () => {
    try {
      const res = await fetch("/api/model/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: null,
          projectId: null,
          message: "engine smoke test — diagnostic ping.",
          currentModelId: form?.normalChatRecommenderModelId ?? null,
          currentProvider: null,
          currentReasoningLevel: form?.normalChatRecommenderReasoningLevel ?? null,
          mode: "normal_chat",
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        loudFailure?: boolean;
        diagnostics?: {
          recommenderSource?: string;
          recommenderResolutionReason?: string | null;
        };
      };
      if (body.loudFailure) {
        return {
          kind: "test_fail" as const,
          at: Date.now(),
          detail:
            body.diagnostics?.recommenderResolutionReason ??
            "Recommender refused to run. Check that the engine model is configured and the candidate pool is non-empty.",
        };
      }
      return {
        kind: "test_pass" as const,
        at: Date.now(),
        detail: `Engine reachable (source: ${body.diagnostics?.recommenderSource ?? "unknown"}).`,
      };
    } catch (err) {
      return {
        kind: "test_fail" as const,
        at: Date.now(),
        detail: err instanceof Error ? err.message : "Test request failed.",
      };
    }
  }, [form]);

  // Compute `candidateCount` unconditionally so the hooks rule is
  // satisfied — we still need this number when the page is in the
  // loading state (the spinner UI is below the candidate count in
  // the discovery section above).
  const candidateCount = useMemo(() => {
    if (!form) return 0;
    return rows.filter((r) => {
      if (!r.configured || !r.available) return false;
      if (form.normalChatRecommenderAllowedModels === null) return true;
      return form.normalChatRecommenderAllowedModels.has(r.modelId);
    }).length;
  }, [form, rows]);

  if (loadError) {
    return <ErrorPanel message={loadError} onRetry={() => void loadSettings()} />;
  }
  if (!form || !baseline || !dto) {
    return <LoadingPanel />;
  }

  const errorsByField = new Map<string, FieldError[]>();
  for (const e of serverErrors) {
    const arr = errorsByField.get(e.field) ?? [];
    arr.push(e);
    errorsByField.set(e.field, arr);
  }
  const isDirty = hasFormChanged(form, baseline);
  const isSaving = saveStatus.kind === "saving";

  return (
    <div
      className={cn(
        "flex w-full max-w-6xl flex-col gap-0",
        embedded ? "" : "mx-auto h-dvh overflow-y-auto px-4 py-6 sm:px-8",
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 pb-4">
        <div>
          <div className="flex items-center gap-2">
            {!embedded && (
              <Button asChild variant="ghost" size="icon-sm" aria-label="Back to chat">
                <Link href="/">
                  <ArrowLeft className="size-4" />
                </Link>
              </Button>
            )}
            <h1 className="text-lg font-semibold">Router Settings</h1>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Three focused sections answer: <strong>A</strong> what can I manually select,{" "}
            <strong>B</strong> what model recommends, and <strong>C</strong> what the recommender
            may suggest. Discovery + refresh live above the sections.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle className="mr-1" />
          <Button
            variant="outline"
            size="sm"
            onClick={onDiscardChanges}
            disabled={!isDirty || isSaving}
          >
            Discard changes
          </Button>
          <Button variant="outline" size="sm" onClick={onResetDefaults} disabled={isSaving}>
            <RotateCcw className="size-3.5" />
            Reset to safe defaults
          </Button>
          <Button
            size="sm"
            onClick={onSave}
            disabled={!isDirty || isSaving}
            data-testid="router-settings-save"
          >
            {isSaving ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Save className="size-3.5" />
            )}
            Save
          </Button>
        </div>
      </header>

      {saveStatus.kind === "saved" && (
        <div
          data-testid="router-settings-save-status"
          className="mt-3 flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300"
        >
          Saved. Settings B (engine) and C (candidates) updated.
        </div>
      )}
      {saveStatus.kind === "error" && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div>
            <div className="font-medium">{saveStatus.message}</div>
            {serverErrors.length > 0 && (
              <ul className="mt-1 list-inside list-disc">
                {serverErrors.map((e, idx) => (
                  <li key={`${e.field}-${idx}`}>{e.message}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <main className="mt-6 space-y-6 pb-12">
        <DiscoverySection
          fakeMode={dto.effectiveRegistry.fakeMode}
          counts={dto.effectiveRegistry.counts}
          discovery={dto.effectiveRegistry.discovery}
          minimaxDiscovery={dto.effectiveRegistry.minimaxDiscovery}
          refreshStatus={refreshStatus}
          onRefresh={() => void onRefreshDiscovery()}
        />

        {/* Tab A — Manual chat picker. Persists via /api/model-selector-prefs
            when the user flips a switch (no global Save needed). */}
        <ManualChatPickerTab
          registry={rows}
          selectorPrefs={selectorPrefs}
          saving={selectorSaving}
          saveError={selectorError}
          defaultVisibleFor={defaultVisibleFor}
          onToggle={onToggleSelectorVisible}
          onBulkSetAllVisible={onBulkSetAllVisible}
        />

        {/* Tab B — Recommender engine. Compact card, batches into Save. */}
        <RecommenderEngineTab
          registry={rows}
          engineModelId={form.normalChatRecommenderModelId}
          engineReasoningOption={form.normalChatRecommenderReasoningLevel}
          allowOpenAiApiRouter={dto.effective.allowOpenAiApiRouter}
          engineOptions={engineOptions}
          candidatePoolSize={candidateCount}
          onEngineModelChange={(id) => update({ normalChatRecommenderModelId: id })}
          onEngineReasoningChange={(opt) => update({ normalChatRecommenderReasoningLevel: opt })}
          fallbackModelId={form.normalChatRecommenderFallbackModelId}
          fallbackReasoningOption={form.normalChatRecommenderFallbackReasoningLevel}
          onFallbackModelChange={(id) =>
            update({
              normalChatRecommenderFallbackModelId: id,
              // Clear the reasoning level whenever the user clears
              // the fallback model — the validator enforces the
              // (model + level) pair as a unit.
              normalChatRecommenderFallbackReasoningLevel:
                id === null ? null : form.normalChatRecommenderFallbackReasoningLevel,
            })
          }
          onFallbackReasoningChange={(opt) =>
            update({ normalChatRecommenderFallbackReasoningLevel: opt })
          }
          promptPreview={dto.normalChatRecommenderPrompt}
          onTestEngine={onTestEngine}
          saveError={
            errorsByField.has("normalChatRecommenderModelId")
              ? (errorsByField.get("normalChatRecommenderModelId")?.[0]?.message ?? null)
              : errorsByField.has("normalChatRecommenderFallbackModelId")
                ? (errorsByField.get("normalChatRecommenderFallbackModelId")?.[0]?.message ?? null)
                : null
          }
        />

        {/* Tab C — Recommender candidates. Per-row allowlist + per-row
            reasoning/thinking options, batches into Save. */}
        <RecommenderCandidatesTab
          registry={rows}
          modelAllowlist={
            form.normalChatRecommenderAllowedModels === null
              ? null
              : [...form.normalChatRecommenderAllowedModels]
          }
          allowedCombos={[...form.allowedComboKeys].map((k) => {
            const [modelId, reasoningLevel] = k.split("|") as [string, string];
            return { modelId, reasoningLevel };
          })}
          selectorPrefs={selectorPrefs}
          onToggleRecommenderForModel={toggleRecommenderForModel}
          onToggleReasoningCombo={toggleReasoningCombo}
          onAllowSubscriptionStandard={onAllowSubscriptionStandard}
          onAllowAll={onAllowAll}
          onBlockApiBilled={onBlockApiBilled}
          onBlockAll={onBlockAll}
          onResetSafeDefaults={onResetSafeDefaults}
          candidateCount={candidateCount}
          fieldErrors={serverErrors}
        />

        {/* Legacy Router A/B settings card.
            Per the brief we are NOT solving Router A/B in this pass —
            the global guards + failure behavior stay where they are so
            existing flows keep working. We render them below the tabs
            as a separate, smaller card labeled clearly so users don't
            confuse them with the new tabs. */}
        <section
          aria-labelledby="legacy-router-ab-heading"
          className="rounded-lg border border-border/60 bg-card p-4 sm:p-6"
          data-testid="router-settings-section-legacy-ab"
        >
          <div>
            <h2 id="legacy-router-ab-heading" className="text-sm font-semibold">
              Router A/B (legacy / experimental)
            </h2>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              Only applies when Router A/B is enabled. Does not control normal model routing. Normal model routing uses computed request tokens instead.
            </p>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-border/60 px-3 py-3">
              <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                A/B router model
              </label>
              <select
                data-testid="router-settings-router-model"
                value={form.routerModelId}
                onChange={(e) => update({ routerModelId: e.target.value })}
                className="border-input bg-background mt-2 flex h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none"
              >
                {rows
                  .filter((r) => r.providerId === "openai" && r.configured)
                  .map((r) => (
                    <option key={r.modelId} value={r.modelId}>
                      {r.displayLabel}
                    </option>
                  ))}
              </select>
            </div>
            <div className="rounded-md border border-border/60 px-3 py-3">
              <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                Failure behavior
              </label>
              <select
                data-testid="router-settings-failure-behavior"
                value={form.failureBehavior}
                onChange={(e) =>
                  update({ failureBehavior: e.target.value as RouterFailureBehavior })
                }
                className="border-input bg-background mt-2 flex h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none"
              >
                <option value="fail_loud">Fail loud</option>
                <option value="suggest_alternative">Suggest alternative</option>
                <option value="auto_fallback">Auto fallback (advanced)</option>
              </select>
            </div>
            <div className="rounded-md border border-border/60 px-3 py-3">
              <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                Legacy A/B long-prompt threshold (characters)
              </label>
              <Input
                type="number"
                min={0}
                value={form.longPromptThresholdChars}
                onChange={(e) => update({ longPromptThresholdChars: e.target.value })}
                data-testid="router-settings-threshold"
                className="mt-2 max-w-[12rem]"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Character-based legacy threshold for Side B A/B only. Normal model routing uses computed request tokens.
              </p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
};
