"use client";

import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpDown,
  CheckCircle2,
  Eye,
  EyeOff,
  Filter,
  Info,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

import type { RouterSettings } from "@/lib/router/schema";
import type { ReasoningLevel } from "@/lib/providers/types";

/**
 * Router Settings page (client component).
 *
 * Renders the Settings UI for the Router A/B mode singleton row in
 * Postgres, organized into three sections per the brief:
 *
 *   A. OpenAI Model Discovery
 *      - last refreshed timestamp
 *      - manual refresh button
 *      - refresh status / error
 *      - summary counts in plain English:
 *        "118 OpenAI models discovered, 3 fully configured, 115
 *         available but unclassified"
 *      - dev/fake mode banner
 *
 *   B. Manual Model Selector
 *      - per-model show/hide toggle for every discovered OpenAI model
 *      - each row exposes OpenAI availability and Control Room
 *        configuration as TWO STACKED COLUMNS so the user sees
 *        "OpenAI says I can use this" vs "Control Room knows about
 *        this" as separate facts
 *      - "Unclassified" badge (renamed from "UNKNOWN") for models
 *        that OpenAI exposes but Control Room has no local metadata
 *        for; unconfigured models can be opted into for
 *        experimentation
 *      - inline warning when the user enables an unconfigured model
 *      - capability placeholders (disabled): Reasoning, Vision,
 *        Images, Function calling, Structured output, Streaming
 *      - sorting + search filter so the table stays usable as the
 *        OpenAI catalog grows
 *
 *   C. Router Recommendation Pool (existing router settings UI)
 *      - allowed (model + reasoning-level) checkboxes
 *      - fallback model + reasoning level
 *      - allow expensive models / long-prompt safety controls
 *      - explicit "Side B only" copy so the user knows what they're
 *        editing
 *      - strict gate: unconfigured + stale models cannot enter the
 *        pool (router safety unchanged)
 *
 * Pricing knobs (`maxCostPerRecommendationUsd`, `maxCostPerAbRunUsd`)
 * and the router model id are intentionally NOT exposed here.
 */

type RegistryEntry = {
  modelId: string;
  modelLabel: string;
  reasoningLevel: ReasoningLevel;
  tier: "cheap" | "expensive";
  configured: boolean;
  available: boolean;
  stale: boolean;
};

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

type EffectiveRegistryModelDto = {
  modelId: string;
  displayLabel: string;
  configured: boolean;
  available: boolean;
  stale: boolean;
  supportsReasoning: boolean;
  supportedReasoningLevels: ReadonlyArray<ReasoningLevel>;
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
  provenance: "local_meta" | "discovered_only" | "fake" | "stale";
};

type RouterSettingsDto = {
  effective: RouterSettings;
  defaults: RouterSettings;
  configured: boolean;
  registry: ReadonlyArray<RegistryEntry>;
  effectiveRegistry: {
    models: ReadonlyArray<EffectiveRegistryModelDto>;
    defaults: { manualModelId: string | null; reasoningLevel: ReasoningLevel };
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
    selectorPrefs: Record<string, { visible: boolean }>;
    fakeMode: boolean;
  };
};

type FormState = {
  allowedComboKeys: Set<string>;
  fallbackModelId: string;
  fallbackReasoningLevel: ReasoningLevel;
  allowExpensiveModels: boolean;
  allowLongPromptWhenExpensive: boolean;
  longPromptThresholdChars: string;
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
      source: "openai" | "fake" | "cache_fresh";
    }
  | { kind: "refresh_error"; at: number; message: string };

type SelectorSort = "configured-first" | "unclassified-first" | "hidden-first" | "available";
type SelectorFilter = "all" | "configured" | "unclassified" | "hidden" | "available";

function comboKey(modelId: string, reasoningLevel: ReasoningLevel): string {
  return `${modelId}|${reasoningLevel}`;
}

function initialForm(dto: RouterSettingsDto): FormState {
  return {
    allowedComboKeys: new Set(
      dto.effective.allowedCombos.map((c) => comboKey(c.modelId, c.reasoningLevel)),
    ),
    fallbackModelId: dto.effective.fallbackModelId,
    fallbackReasoningLevel: dto.effective.fallbackReasoningLevel,
    allowExpensiveModels: dto.effective.allowExpensiveModels,
    allowLongPromptWhenExpensive: dto.effective.allowLongPromptWhenExpensive,
    longPromptThresholdChars:
      dto.effective.longPromptThresholdChars === 0
        ? ""
        : String(dto.effective.longPromptThresholdChars),
  };
}

function formToPayload(
  form: FormState,
  registry: ReadonlyArray<RegistryEntry>,
): {
  payload: Record<string, unknown>;
  clientErrors: ReadonlyArray<FieldError>;
} {
  const errors: FieldError[] = [];
  const registryKeys = new Set(registry.map((e) => comboKey(e.modelId, e.reasoningLevel)));
  const cleanedKeys = [...form.allowedComboKeys].filter((k) => registryKeys.has(k));
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

  const fallbackKey = comboKey(form.fallbackModelId, form.fallbackReasoningLevel);
  if (cleanedKeys.length > 0 && !cleanedKeys.includes(fallbackKey)) {
    errors.push({
      field: "fallbackCombo",
      message: `Fallback (${form.fallbackModelId} / ${form.fallbackReasoningLevel}) must be one of the checked combinations.`,
    });
  }

  const allowedCombos = cleanedKeys.map((k) => {
    const [modelId, reasoningLevel] = k.split("|") as [string, ReasoningLevel];
    return { modelId, reasoningLevel };
  });

  return {
    payload: {
      allowExpensiveModels: form.allowExpensiveModels,
      allowLongPromptWhenExpensive: form.allowLongPromptWhenExpensive,
      longPromptThresholdChars: threshold,
      fallbackModelId: form.fallbackModelId,
      fallbackReasoningLevel: form.fallbackReasoningLevel,
      allowedCombos,
    },
    clientErrors: errors,
  };
}

function hasFormChanged(form: FormState, baseline: FormState): boolean {
  if (form.allowExpensiveModels !== baseline.allowExpensiveModels) return true;
  if (form.allowLongPromptWhenExpensive !== baseline.allowLongPromptWhenExpensive) return true;
  if (form.fallbackModelId !== baseline.fallbackModelId) return true;
  if (form.fallbackReasoningLevel !== baseline.fallbackReasoningLevel) return true;
  if (form.longPromptThresholdChars !== baseline.longPromptThresholdChars) return true;
  if (form.allowedComboKeys.size !== baseline.allowedComboKeys.size) return true;
  for (const k of form.allowedComboKeys) {
    if (!baseline.allowedComboKeys.has(k)) return true;
  }
  return false;
}

function formatRelativeAge(ageMs: number | null): string {
  if (ageMs === null) return "never";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const REASONING_LEVELS: ReadonlyArray<ReasoningLevel> = ["low", "medium", "high"];

const CAPABILITY_LABELS: ReadonlyArray<{
  key: "reasoning" | "vision" | "images" | "functionCalling" | "structuredOutput" | "streaming";
  label: string;
}> = [
  { key: "reasoning", label: "Reasoning" },
  { key: "vision", label: "Vision" },
  { key: "images", label: "Images" },
  { key: "functionCalling", label: "Function calling" },
  { key: "structuredOutput", label: "Structured output" },
  { key: "streaming", label: "Streaming" },
];

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
 * Small two-line "OK / Not OK" pill used inside the manual-selector table
 * to keep OpenAI availability and Control Room support visually separate.
 *
 *   ✓ Available        (green)
 *   ✗ Unavailable      (zinc)
 *
 *   ✓ Configured       (emerald)
 *   ⚠ Not configured   (zinc/amber)
 *
 * The brief is explicit that these two facts must not be conflated.
 */
const StatusPill: FC<{
  ok: boolean;
  okLabel: string;
  badLabel: string;
  testId?: string;
}> = ({ ok, okLabel, badLabel, testId }) => {
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
        ok
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-zinc-500/40 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
      )}
    >
      {ok ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
      {ok ? okLabel : badLabel}
    </span>
  );
};

/**
 * Renders the future capability placeholders as a column of disabled
 * checkboxes. The brief calls for these to be present (so the UI is
 * ready when the capability registry ships) but not yet functional.
 *
 * We pass a `populated` map so a configured model with reasoning
 * metadata shows its check actually checked; everything else stays
 * unchecked + disabled.
 */
const CapabilityList: FC<{
  capabilities: EffectiveRegistryModelDto["capabilities"];
  testIdPrefix: string;
}> = ({ capabilities, testIdPrefix }) => {
  return (
    <ul className="flex flex-col gap-1">
      {CAPABILITY_LABELS.map((cap) => {
        const checked = capabilities[cap.key];
        return (
          <li
            key={cap.key}
            className="flex items-center gap-1.5 text-[10px] text-muted-foreground/80"
          >
            <Checkbox
              checked={checked}
              disabled
              aria-label={`${cap.label} (future capability placeholder)`}
              data-testid={`${testIdPrefix}-capability-${cap.key}`}
              className="size-3"
            />
            <span>{cap.label}</span>
          </li>
        );
      })}
    </ul>
  );
};

/**
 * Inline warning shown next to the visibility toggle when the user is
 * about to enable a model Control Room has no local metadata for.
 * Matches the brief's required copy.
 */
const UnconfiguredWarning: FC<{ modelLabel: string }> = ({ modelLabel }) => {
  return (
    <div
      className="mt-1 max-w-[260px] rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[10px] text-amber-700 dark:text-amber-300"
      role="note"
    >
      <div className="flex items-start gap-1.5">
        <Info className="mt-0.5 size-3 shrink-0" />
        <div>
          <div className="font-medium">Not configured in Control Room</div>
          <div className="text-amber-700/80 dark:text-amber-300/80">
            {modelLabel} has not yet been configured in Control Room. Reasoning-level support and
            router support are unknown.
          </div>
        </div>
      </div>
    </div>
  );
};

export const RouterSettingsPage: FC = () => {
  const [dto, setDto] = useState<RouterSettingsDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [baseline, setBaseline] = useState<FormState | null>(null);
  const [serverErrors, setServerErrors] = useState<ReadonlyArray<FieldError>>([]);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: "idle" });
  const [refreshStatus, setRefreshStatus] = useState<RefreshStatus>({ kind: "idle" });
  const [selectorSaving, setSelectorSaving] = useState<Record<string, boolean>>({});
  const [selectorError, setSelectorError] = useState<string | null>(null);

  // Manual-selector UI state (sort + filter + search). The persisted
  // selector prefs are owned by the backend; this is purely client-side
  // presentation state so the user can find what they're looking for
  // without scrolling through 100+ ids.
  const [sortMode, setSortMode] = useState<SelectorSort>("configured-first");
  const [filterMode, setFilterMode] = useState<SelectorFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [warningDismissedFor, setWarningDismissedFor] = useState<Record<string, boolean>>({});

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

  const registry = useMemo(() => dto?.registry ?? [], [dto]);

  const registryByModel = useMemo(() => {
    const m = new Map<string, RegistryEntry[]>();
    for (const e of registry) {
      const arr = m.get(e.modelId) ?? [];
      arr.push(e);
      m.set(e.modelId, arr);
    }
    return m;
  }, [registry]);

  const fallbackModelLevels = useMemo<ReadonlyArray<ReasoningLevel>>(() => {
    if (!form) return REASONING_LEVELS;
    const entries = registryByModel.get(form.fallbackModelId) ?? [];
    const supported = entries.map((e) => e.reasoningLevel);
    if (supported.length === 0) return REASONING_LEVELS;
    return supported;
  }, [form, registryByModel]);

  const registryByModelEntries = useMemo(() => {
    const out: Array<{
      modelId: string;
      modelLabel: string;
      tier: "cheap" | "expensive";
      configured: boolean;
      available: boolean;
      stale: boolean;
      levels: RegistryEntry[];
    }> = [];
    const seen = new Set<string>();
    for (const e of registry) {
      if (seen.has(e.modelId)) continue;
      seen.add(e.modelId);
      out.push({
        modelId: e.modelId,
        modelLabel: e.modelLabel,
        tier: e.tier,
        configured: e.configured,
        available: e.available,
        stale: e.stale,
        levels: registry.filter((r) => r.modelId === e.modelId),
      });
    }
    return out;
  }, [registry]);

  const selectorEntries = useMemo(() => dto?.effectiveRegistry.models ?? [], [dto]);
  const selectorPrefs = useMemo(() => dto?.effectiveRegistry.selectorPrefs ?? {}, [dto]);
  const discovery = useMemo(() => dto?.effectiveRegistry.discovery, [dto]);
  const counts = useMemo(() => dto?.effectiveRegistry.counts, [dto]);

  // Effective visible-set for the manual selector table, after applying
  // the user's sort + filter + search. Persisted prefs are unchanged;
  // this is presentation-only.
  const visibleSelectorEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const matchesSearch = (entry: EffectiveRegistryModelDto) =>
      q.length === 0 ||
      entry.modelId.toLowerCase().includes(q) ||
      entry.displayLabel.toLowerCase().includes(q);

    const matchesFilter = (entry: EffectiveRegistryModelDto): boolean => {
      switch (filterMode) {
        case "all":
          return true;
        case "configured":
          return entry.configured;
        case "unclassified":
          return !entry.configured && !entry.stale;
        case "hidden": {
          const pref = selectorPrefs[entry.modelId]?.visible;
          const visible = pref !== undefined ? pref : entry.manualSelectorVisible;
          return !visible;
        }
        case "available":
          return entry.available && !entry.stale;
      }
    };

    const filtered = selectorEntries.filter((e) => matchesFilter(e) && matchesSearch(e));
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sortMode) {
        case "configured-first":
          // Configured first, then by availability, then alphabetical.
          if (a.configured !== b.configured) return a.configured ? -1 : 1;
          if (a.available !== b.available) return a.available ? -1 : 1;
          return a.modelId.localeCompare(b.modelId);
        case "unclassified-first":
          if (a.configured !== b.configured) return a.configured ? 1 : -1;
          if (a.available !== b.available) return a.available ? -1 : 1;
          return a.modelId.localeCompare(b.modelId);
        case "hidden-first": {
          const aPref = selectorPrefs[a.modelId]?.visible;
          const bPref = selectorPrefs[b.modelId]?.visible;
          const aVisible = aPref !== undefined ? aPref : a.manualSelectorVisible;
          const bVisible = bPref !== undefined ? bPref : b.manualSelectorVisible;
          if (aVisible !== bVisible) return aVisible ? 1 : -1;
          return a.modelId.localeCompare(b.modelId);
        }
        case "available":
          if (a.available !== b.available) return a.available ? -1 : 1;
          return a.modelId.localeCompare(b.modelId);
      }
    });
    return sorted;
  }, [selectorEntries, selectorPrefs, sortMode, filterMode, searchQuery]);

  const update = useCallback(
    (patch: Partial<FormState>) => {
      setForm((prev) => {
        if (!prev) return prev;
        const next = { ...prev, ...patch };
        const supported = (registryByModel.get(next.fallbackModelId) ?? []).map(
          (e) => e.reasoningLevel,
        );
        if (supported.length > 0 && !supported.includes(next.fallbackReasoningLevel)) {
          next.fallbackReasoningLevel = supported[0];
        }
        return next;
      });
    },
    [registryByModel],
  );

  const toggleCombo = useCallback(
    (modelId: string, reasoningLevel: ReasoningLevel, enabled: boolean) => {
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

  const toggleAllForModel = useCallback(
    (modelId: string, enabled: boolean) => {
      setForm((prev) => {
        if (!prev) return prev;
        const next = new Set(prev.allowedComboKeys);
        for (const e of registry) {
          if (e.modelId !== modelId) continue;
          const k = comboKey(e.modelId, e.reasoningLevel);
          if (enabled) next.add(k);
          else next.delete(k);
        }
        return { ...prev, allowedComboKeys: next };
      });
    },
    [registry],
  );

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
    const { payload, clientErrors } = formToPayload(form, registry);
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
  }, [form, dto, registry]);

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
        outcome:
          | { kind: "fresh"; source: "openai" | "fake"; modelCount: number }
          | { kind: "cache_fresh"; ageMs: number; modelCount: number }
          | {
              kind: "failed";
              reason: string;
              usedCache: boolean;
              modelCount: number;
            };
      };
      if (data.outcome.kind === "fresh") {
        setRefreshStatus({
          kind: "refreshed",
          at: Date.now(),
          modelCount: data.outcome.modelCount,
          source: data.outcome.source,
        });
      } else if (data.outcome.kind === "cache_fresh") {
        setRefreshStatus({
          kind: "refreshed",
          at: Date.now(),
          modelCount: data.outcome.modelCount,
          source: "cache_fresh",
        });
      } else {
        setRefreshStatus({
          kind: "refresh_error",
          at: Date.now(),
          message: `${data.outcome.reason}${data.outcome.usedCache ? " (using cached discovery)" : ""}`,
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
      // Reset the inline-warning dismissal when the user re-toggles.
      setWarningDismissedFor((w) => ({ ...w, [modelId]: false }));
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
  const isExpensiveAllowed = form.allowExpensiveModels;

  return (
    <div className="mx-auto flex h-dvh w-full max-w-4xl flex-col gap-0 overflow-y-auto px-4 py-6 sm:px-8">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="icon-sm" aria-label="Back to chat">
              <Link href="/">
                <ArrowLeft className="size-4" />
              </Link>
            </Button>
            <h1 className="text-lg font-semibold">Router Settings</h1>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Choose which OpenAI models appear in the chat composer (Section B) and which
            combinations the router is allowed to recommend for Side B (Section C).
          </p>
        </div>
        <div className="flex items-center gap-2">
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
          <CheckCircle2 className="size-3.5" />
          Saved. New A/B prompts will use the updated allowlist.
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

      <main className="mt-6 space-y-8 pb-12">
        {/* Section A: OpenAI Model Discovery */}
        <section
          aria-labelledby="discovery-heading"
          className="rounded-lg border border-border/60 bg-card p-4 sm:p-6"
          data-testid="router-settings-section-discovery"
        >
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 id="discovery-heading" className="text-sm font-semibold">
                A · OpenAI model discovery
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Control Room calls OpenAI&apos;s{" "}
                <code className="rounded bg-muted px-1">/v1/models</code> to learn which model ids
                are available to your API key. The last successful payload is cached in Postgres and
                reused until you refresh or it goes stale.
              </p>
            </div>
          </div>

          {dto.effectiveRegistry.fakeMode && (
            <div
              data-testid="discovery-fake-banner"
              className="mt-3 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
            >
              <AlertTriangle className="size-3.5 shrink-0" />
              Dev / Playwright mode: discovery returns a fixed list of four fake ids instead of
              calling OpenAI. Production builds never see fake ids unless this flag is set.
            </div>
          )}

          {/* Plain-English summary. The brief calls for "118 OpenAI models
              discovered, 3 fully configured, 115 available but
              unclassified" rather than the previous "118 / 3" shorthand. */}
          <div
            className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3"
            data-testid="discovery-summary"
          >
            <div
              className="rounded-md border border-border/60 px-3 py-2"
              data-testid="discovery-summary-discovered"
            >
              <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                OpenAI models discovered
              </dt>
              <dd className="mt-1 flex items-baseline gap-1 text-sm">
                <span className="text-lg font-semibold">{counts?.discovered ?? 0}</span>
                <span className="text-xs text-muted-foreground/70">total in latest refresh</span>
              </dd>
            </div>
            <div
              className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2"
              data-testid="discovery-summary-configured"
            >
              <dt className="text-[10px] font-medium uppercase tracking-wide text-emerald-700/80 dark:text-emerald-300/80">
                Fully configured
              </dt>
              <dd className="mt-1 flex items-baseline gap-1 text-sm">
                <span className="text-lg font-semibold text-emerald-700 dark:text-emerald-300">
                  {counts?.discoveredConfigured ?? 0}
                </span>
                <span className="text-xs text-emerald-700/70 dark:text-emerald-300/70">
                  have local metadata
                </span>
              </dd>
            </div>
            <div
              className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2"
              data-testid="discovery-summary-unclassified"
            >
              <dt className="text-[10px] font-medium uppercase tracking-wide text-amber-700/80 dark:text-amber-300/80">
                Available but unclassified
              </dt>
              <dd className="mt-1 flex items-baseline gap-1 text-sm">
                <span className="text-lg font-semibold text-amber-700 dark:text-amber-300">
                  {counts?.discoveredUnclassified ?? 0}
                </span>
                <span className="text-xs text-amber-700/70 dark:text-amber-300/70">
                  no local metadata
                </span>
              </dd>
            </div>
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="discovery-status">
            <div className="rounded-md border border-border/60 px-3 py-2">
              <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                Last refreshed
              </dt>
              <dd className="mt-1 text-sm">
                {discovery?.fetchedAt
                  ? `${formatRelativeAge(discovery.ageMs)} (${discovery.source})`
                  : "never"}
              </dd>
            </div>
            <div className="rounded-md border border-border/60 px-3 py-2">
              <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                Stale entries
              </dt>
              <dd className="mt-1 text-sm">
                {counts?.stale ?? 0}
                <span className="ml-1 text-xs text-muted-foreground/70">
                  configured but disappeared
                </span>
              </dd>
            </div>
            <div className="rounded-md border border-border/60 px-3 py-2">
              <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                In manual selector
              </dt>
              <dd className="mt-1 text-sm">{counts?.manualSelectorVisible ?? 0}</dd>
            </div>
            <div className="rounded-md border border-border/60 px-3 py-2">
              <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                Router eligible
              </dt>
              <dd className="mt-1 text-sm">{counts?.routerEligible ?? 0}</dd>
            </div>
          </dl>

          {discovery?.errorMessage && (
            <div
              data-testid="discovery-error"
              className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <div>
                <div className="font-medium">Last refresh failed</div>
                <div className="text-destructive/80">{discovery.errorMessage}</div>
              </div>
            </div>
          )}

          <div className="mt-3 flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void onRefreshDiscovery()}
              disabled={refreshStatus.kind === "refreshing"}
              data-testid="discovery-refresh-button"
            >
              {refreshStatus.kind === "refreshing" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Refresh OpenAI models now
            </Button>
            {refreshStatus.kind === "refreshed" && (
              <span
                className="text-xs text-muted-foreground"
                data-testid="discovery-refresh-status"
              >
                Refreshed {formatRelativeAge(Date.now() - refreshStatus.at)} ({refreshStatus.source}
                , {refreshStatus.modelCount} models).
              </span>
            )}
            {refreshStatus.kind === "refresh_error" && (
              <span className="text-xs text-destructive" data-testid="discovery-refresh-error">
                Refresh failed: {refreshStatus.message}
              </span>
            )}
          </div>
        </section>

        {/* Section B: Manual Model Selector */}
        <section
          aria-labelledby="selector-heading"
          className="rounded-lg border border-border/60 bg-card p-4 sm:p-6"
          data-testid="router-settings-section-selector"
        >
          <div>
            <h2 id="selector-heading" className="text-sm font-semibold">
              B · Manual model selector
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Choose which discovered OpenAI models appear in the chat composer dropdown. Hidden
              models do not appear in chat, but messages that already used them remain in history.
              Decoupled from the router pool (Section C) — a model hidden here may still be
              router-eligible, and a model shown here may still be router-blocked.
            </p>
          </div>

          {selectorError && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <div>{selectorError}</div>
            </div>
          )}

          {/* Sort + filter + search controls. The list can be very long
              (OpenAI's catalog is ~120 entries) so we let the user
              narrow it. */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                type="text"
                placeholder="Search models by id or label…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                data-testid="selector-search"
                className="pl-8"
              />
            </div>
            <div className="flex items-center gap-1">
              <Filter className="size-3.5 text-muted-foreground/60" />
              <select
                aria-label="Filter"
                value={filterMode}
                onChange={(e) => setFilterMode(e.target.value as SelectorFilter)}
                data-testid="selector-filter"
                className="border-input bg-background flex h-9 rounded-md border px-2 text-xs shadow-xs outline-none"
              >
                <option value="all">All ({selectorEntries.length})</option>
                <option value="configured">Configured only</option>
                <option value="unclassified">Unclassified only</option>
                <option value="available">Available from OpenAI</option>
                <option value="hidden">Hidden from picker</option>
              </select>
            </div>
            <div className="flex items-center gap-1">
              <ArrowUpDown className="size-3.5 text-muted-foreground/60" />
              <select
                aria-label="Sort"
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SelectorSort)}
                data-testid="selector-sort"
                className="border-input bg-background flex h-9 rounded-md border px-2 text-xs shadow-xs outline-none"
              >
                <option value="configured-first">Configured first</option>
                <option value="unclassified-first">Unclassified first</option>
                <option value="hidden-first">Hidden first</option>
                <option value="available">Available first</option>
              </select>
            </div>
          </div>

          <div
            className="mt-2 text-xs text-muted-foreground/70"
            data-testid="selector-result-count"
          >
            Showing {visibleSelectorEntries.length} of {selectorEntries.length} models
            {searchQuery ? ` matching “${searchQuery}”` : ""}
            {filterMode !== "all" ? ` (filter: ${filterMode})` : ""}.
          </div>

          <div className="mt-3 overflow-hidden rounded-md border border-border/60">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground/70">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Model</th>
                  <th className="px-3 py-2 text-left font-medium">OpenAI</th>
                  <th className="px-3 py-2 text-left font-medium">Control Room</th>
                  <th className="px-3 py-2 text-left font-medium">Capabilities</th>
                  <th className="px-3 py-2 text-right font-medium">In selector</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {visibleSelectorEntries.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-3 py-6 text-center text-xs text-muted-foreground/60"
                    >
                      No models match the current filter / search.
                    </td>
                  </tr>
                )}
                {visibleSelectorEntries.map((entry) => {
                  const prefVisible = selectorPrefs[entry.modelId]?.visible;
                  const defaultVisible = entry.manualSelectorVisible;
                  const visible = prefVisible !== undefined ? prefVisible : defaultVisible;
                  // The server-computed `manuallyOverridden` only updates
                  // when we re-fetch the registry. For instant feedback
                  // after toggling, derive it from the local selector
                  // prefs map (which is updated optimistically on click).
                  const manuallyOverridden = prefVisible !== undefined || entry.manuallyOverridden;
                  const saving = Boolean(selectorSaving[entry.modelId]);
                  const showInlineWarning =
                    visible && !entry.configured && !warningDismissedFor[entry.modelId];
                  const toggleDisabled = saving;
                  return (
                    <tr
                      key={entry.modelId}
                      data-testid={`selector-row-${entry.modelId}`}
                      data-configured={entry.configured ? "true" : "false"}
                      className={cn("transition-colors", entry.stale && "bg-muted/20")}
                    >
                      <td className="px-3 py-2 align-top">
                        <div className="font-medium">{entry.displayLabel}</div>
                        <div className="text-[11px] text-muted-foreground/70">{entry.modelId}</div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {!entry.configured && !entry.stale && (
                            <span
                              data-testid={`selector-badge-unclassified-${entry.modelId}`}
                              className="inline-flex items-center rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-rose-700 dark:text-rose-300"
                            >
                              unclassified
                            </span>
                          )}
                          {entry.provenance === "fake" && (
                            <span
                              data-testid={`selector-badge-fake-${entry.modelId}`}
                              className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300"
                            >
                              fake
                            </span>
                          )}
                          {entry.provenance === "stale" && (
                            <span
                              data-testid={`selector-badge-stale-${entry.modelId}`}
                              className="inline-flex items-center rounded-full border border-zinc-500/40 bg-zinc-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-700 dark:text-zinc-300"
                            >
                              stale
                            </span>
                          )}
                          {manuallyOverridden && (
                            <span
                              data-testid={`selector-badge-overridden-${entry.modelId}`}
                              className="inline-flex items-center rounded-full border border-blue-500/40 bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300"
                            >
                              override
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top">
                        {/* OpenAI column: just availability. The brief
                            explicitly wants this separated from "Control
                            Room knows about this model". */}
                        <div className="flex flex-col gap-1">
                          <StatusPill
                            ok={entry.available}
                            okLabel="Available"
                            badLabel="Unavailable"
                            testId={`selector-openai-pill-${entry.modelId}`}
                          />
                          {entry.available ? (
                            <Eye className="size-3 text-emerald-600/60 dark:text-emerald-400/60" />
                          ) : (
                            <EyeOff className="size-3 text-zinc-500/60" />
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top">
                        {/* Control Room column: configured (local
                            metadata) vs not configured. Independent of
                            OpenAI availability. */}
                        <div className="flex flex-col gap-1">
                          <StatusPill
                            ok={entry.configured}
                            okLabel="Configured"
                            badLabel="Not configured"
                            testId={`selector-controlroom-pill-${entry.modelId}`}
                          />
                          {entry.configured ? (
                            <Sparkles className="size-3 text-emerald-600/60 dark:text-emerald-400/60" />
                          ) : (
                            <span className="text-[10px] text-muted-foreground/60">
                              no local metadata
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <CapabilityList
                          capabilities={entry.capabilities}
                          testIdPrefix={`selector-${entry.modelId}`}
                        />
                      </td>
                      <td className="px-3 py-2 align-top text-right">
                        <div className="flex flex-col items-end gap-1">
                          <Switch
                            checked={visible}
                            disabled={toggleDisabled}
                            onCheckedChange={(v) => void onToggleSelectorVisible(entry.modelId, v)}
                            aria-label={`Show ${entry.displayLabel} in manual selector`}
                            data-testid={`selector-toggle-${entry.modelId}`}
                          />
                          {showInlineWarning && (
                            <UnconfiguredWarning modelLabel={entry.displayLabel} />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-muted-foreground/70">
            <strong>OpenAI</strong> = what OpenAI&apos;s{" "}
            <code className="rounded bg-muted px-1">/v1/models</code> says you can call.{" "}
            <strong>Control Room</strong> = whether this build has local metadata (display label,
            tier, reasoning levels) for it. Models with ✓ on both rows are the safest picks; the
            router only ever picks from those. Unclassified models can be enabled for
            experimentation, but the router will never select them.
          </p>
        </section>

        {/* Section C: Router Recommendation Pool */}
        <section
          aria-labelledby="allowlist-heading"
          className={cn(
            "rounded-lg border border-border/60 bg-card p-4 sm:p-6",
            errorsByField.has("allowedCombos") && "border-destructive/60",
          )}
          data-testid="router-settings-section-pool"
        >
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 id="allowlist-heading" className="text-sm font-semibold">
                C · Router recommendation pool (Side B only)
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                The router picks one of the checked combinations below for Side B. Side A (the
                user&apos;s selected model) is never touched here. Only configured, currently
                available models appear here; unconfigured and stale models cannot enter the router
                pool.
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>
                {form.allowedComboKeys.size} of {registry.length} checked
              </span>
            </div>
          </div>

          <div className="mt-4 overflow-hidden rounded-md border border-border/60">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground/70">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Model</th>
                  <th className="px-3 py-2 text-left font-medium">Tier</th>
                  {REASONING_LEVELS.map((level) => (
                    <th key={level} className="px-3 py-2 text-center font-medium capitalize">
                      {level}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right font-medium">All</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {registryByModelEntries.map((row) => {
                  const allChecked = row.levels.every((l) =>
                    form.allowedComboKeys.has(comboKey(l.modelId, l.reasoningLevel)),
                  );
                  const isExpensiveRow = row.tier === "expensive";
                  const isUnavailable = !row.available || row.stale;
                  const disabledByTier = isExpensiveRow && !isExpensiveAllowed;
                  const disabledByState = isUnavailable;
                  return (
                    <tr
                      key={row.modelId}
                      data-testid={`router-settings-row-${row.modelId}`}
                      className={cn(
                        "transition-colors",
                        (disabledByTier || disabledByState) && "bg-muted/20",
                      )}
                    >
                      <td className="px-3 py-2 align-top">
                        <div className="font-medium">{row.modelLabel}</div>
                        <div className="text-[11px] text-muted-foreground/70">{row.modelId}</div>
                        {isUnavailable && (
                          <div
                            className="mt-1 inline-flex items-center rounded-full border border-zinc-500/40 bg-zinc-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-700 dark:text-zinc-300"
                            data-testid={`pool-badge-stale-${row.modelId}`}
                          >
                            {row.stale ? "stale" : "unavailable"}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                            row.tier === "cheap"
                              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                              : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
                          )}
                        >
                          {row.tier}
                        </span>
                      </td>
                      {REASONING_LEVELS.map((level) => {
                        const entry = row.levels.find((l) => l.reasoningLevel === level);
                        if (!entry) {
                          return (
                            <td
                              key={level}
                              className="px-3 py-2 text-center text-xs text-muted-foreground/40"
                              aria-label={`${row.modelLabel} does not support ${level} reasoning`}
                            >
                              —
                            </td>
                          );
                        }
                        const k = comboKey(entry.modelId, entry.reasoningLevel);
                        const checked = form.allowedComboKeys.has(k);
                        const disabled = disabledByTier || disabledByState;
                        return (
                          <td
                            key={level}
                            className="px-3 py-2 text-center"
                            data-testid={`router-settings-combo-${entry.modelId}-${entry.reasoningLevel}`}
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(value) =>
                                toggleCombo(entry.modelId, entry.reasoningLevel, value === true)
                              }
                              disabled={disabled}
                              aria-label={`Allow ${entry.modelLabel} with ${level} reasoning`}
                            />
                          </td>
                        );
                      })}
                      <td className="px-3 py-2 text-right">
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => toggleAllForModel(row.modelId, !allChecked)}
                          disabled={disabledByTier || disabledByState}
                          aria-label={`${allChecked ? "Uncheck" : "Check"} all ${row.modelLabel} combinations`}
                        >
                          {allChecked ? "Clear" : "Check all"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {errorsByField.has("allowedCombos") && (
            <p
              role="alert"
              className="mt-2 text-xs text-destructive"
              data-testid="router-settings-error-allowedCombos"
            >
              {errorsByField.get("allowedCombos")?.[0]?.message}
            </p>
          )}

          {!isExpensiveAllowed && registryByModelEntries.some((r) => r.tier === "expensive") && (
            <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              Expensive-tier combinations are disabled until you turn on &ldquo;Allow expensive
              models&rdquo; below. The router cannot pick an expensive combo unless that switch is
              on.
            </p>
          )}
        </section>

        {/* Section: Fallback */}
        <section
          aria-labelledby="fallback-heading"
          className={cn(
            "rounded-lg border border-border/60 bg-card p-4 sm:p-6",
            errorsByField.has("fallbackCombo") && "border-destructive/60",
          )}
        >
          <h2 id="fallback-heading" className="text-sm font-semibold">
            Fallback combination
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Used when the router call fails or returns a disallowed value. The fallback must be one
            of the allowed combinations above.
          </p>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="fallback-model">Fallback model</Label>
              <select
                id="fallback-model"
                data-testid="router-settings-fallback-model"
                value={form.fallbackModelId}
                onChange={(e) => update({ fallbackModelId: e.target.value })}
                className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 flex h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px]"
              >
                {registryByModelEntries.map((row) => (
                  <option key={row.modelId} value={row.modelId}>
                    {row.modelLabel} ({row.tier})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fallback-reasoning">Fallback reasoning level</Label>
              <select
                id="fallback-reasoning"
                data-testid="router-settings-fallback-reasoning"
                value={form.fallbackReasoningLevel}
                onChange={(e) =>
                  update({ fallbackReasoningLevel: e.target.value as ReasoningLevel })
                }
                className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 flex h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px]"
              >
                {fallbackModelLevels.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {errorsByField.has("fallbackCombo") && (
            <p
              role="alert"
              className="mt-2 text-xs text-destructive"
              data-testid="router-settings-error-fallbackCombo"
            >
              {errorsByField.get("fallbackCombo")?.[0]?.message}
            </p>
          )}
        </section>

        {/* Section: Expensive / long prompt safety */}
        <section
          aria-labelledby="safety-heading"
          className="rounded-lg border border-border/60 bg-card p-4 sm:p-6"
        >
          <h2 id="safety-heading" className="text-sm font-semibold">
            Expensive & long-prompt safety
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            These switches gate the expensive-tier combinations above and decide what happens when a
            user prompt crosses the long-prompt threshold. Both are off by default.
          </p>
          <div className="mt-4 space-y-4">
            <label className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-3">
              <div>
                <div className="text-sm font-medium">Allow expensive models</div>
                <p className="text-xs text-muted-foreground">
                  When off, the router cannot recommend any expensive-tier combination.
                </p>
              </div>
              <Switch
                checked={form.allowExpensiveModels}
                onCheckedChange={(v) => update({ allowExpensiveModels: v })}
                data-testid="router-settings-allow-expensive"
                aria-label="Allow expensive models"
              />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-3">
              <div>
                <div className="text-sm font-medium">Allow expensive models on long prompts</div>
                <p className="text-xs text-muted-foreground">
                  When off, expensive combos are also excluded automatically for prompts at or above
                  the long-prompt threshold.
                </p>
              </div>
              <Switch
                checked={form.allowLongPromptWhenExpensive}
                onCheckedChange={(v) => update({ allowLongPromptWhenExpensive: v })}
                data-testid="router-settings-allow-long-expensive"
                aria-label="Allow expensive models on long prompts"
              />
            </label>
            <div className="rounded-md border border-border/60 px-3 py-3">
              <Label htmlFor="long-prompt-threshold">Long prompt threshold (characters)</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                Leave blank to use the default ({dto.defaults.longPromptThresholdChars}). Used as
                the cutoff above which the long-prompt safety guard kicks in.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Input
                  id="long-prompt-threshold"
                  data-testid="router-settings-threshold"
                  type="number"
                  min={0}
                  step={50}
                  inputMode="numeric"
                  value={form.longPromptThresholdChars}
                  onChange={(e) => update({ longPromptThresholdChars: e.target.value })}
                  className="max-w-[12rem]"
                  aria-invalid={errorsByField.has("longPromptThresholdChars")}
                />
                <span className="text-xs text-muted-foreground">
                  blank = {dto.defaults.longPromptThresholdChars} (default)
                </span>
              </div>
              {errorsByField.has("longPromptThresholdChars") && (
                <p
                  role="alert"
                  className="mt-2 text-xs text-destructive"
                  data-testid="router-settings-error-threshold"
                >
                  {errorsByField.get("longPromptThresholdChars")?.[0]?.message}
                </p>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
};
