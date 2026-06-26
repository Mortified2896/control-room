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
  Lock,
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { RouterFailureBehavior, RouterSettings } from "@/lib/router/schema";
import type { ReasoningLevel } from "@/lib/providers/types";

/**
 * Router Settings page (client component).
 *
 * Renders the Settings UI for the Router A/B mode singleton row in
 * Postgres, organized into three sections per the post-refactor brief:
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
 *   B. Model Registry  (was: Manual Model Selector + Router Recommendation
 *      Pool — merged into a single unified table)
 *      - one row per model
 *      - columns answer all of:
 *          "Can OpenAI access this model?"
 *          "Has Control Room been configured for it?"
 *          "Should it appear in the manual selector?"
 *          "May the router recommend it?"
 *          "Which reasoning levels may the router use?"
 *          "What capabilities are known?"
 *      - manual visibility toggles persist immediately (existing path)
 *      - router toggle + per-reasoning-level checkboxes batch into the
 *        same Save as the global router settings (existing path)
 *      - unconfigured models: router toggle is locked with a tooltip;
 *        manual toggle still works (opt-in for experimentation) with the
 *        existing unconfigured warning
 *      - sort + filter + search preserved
 *
 *   C. Router Global Settings  (only settings that affect the router
 *      globally stay here)
 *      - failure behavior
 *      - allow expensive models
 *      - allow expensive on long prompts
 *      - long prompt threshold
 *      - pricing controls (future)
 *
 * Pricing knobs (`maxCostPerRecommendationUsd`, `maxCostPerAbRunUsd`)
 * and the router model id are intentionally NOT exposed here.
 *
 * This file is a pure UX refactor of the previous split
 * "Manual Selector / Router Pool" surface. The persistence layer
 * (Postgres rows, repos, settings-store cache), the API routes, the
 * validation pipeline, and the router graph are all untouched.
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

type SettingsProviderId = "openai" | "minimax";

type EffectiveRegistryModelDto = {
  providerId: SettingsProviderId;
  providerLabel: string;
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
  provenance: "local_meta" | "discovered_only" | "fake" | "stale" | "env_static";
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
  failureBehavior: RouterFailureBehavior;
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
      minimaxModelCount: number;
      source: "openai" | "fake" | "cache_fresh";
    }
  | { kind: "refresh_error"; at: number; message: string };

type RegistrySort = "configured-first" | "unclassified-first" | "router-first" | "available";
type RegistryFilter =
  | "all"
  | "configured"
  | "not-configured"
  | "manual-enabled"
  | "router-enabled"
  | "available"
  | "unavailable";

function comboKey(modelId: string, reasoningLevel: ReasoningLevel): string {
  return `${modelId}|${reasoningLevel}`;
}

function initialForm(dto: RouterSettingsDto): FormState {
  return {
    allowedComboKeys: new Set(
      dto.effective.allowedCombos.map((c) => comboKey(c.modelId, c.reasoningLevel)),
    ),
    failureBehavior: dto.effective.failureBehavior,
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

  const allowedCombos = cleanedKeys.map((k) => {
    const [modelId, reasoningLevel] = k.split("|") as [string, ReasoningLevel];
    return { modelId, reasoningLevel };
  });

  return {
    payload: {
      allowExpensiveModels: form.allowExpensiveModels,
      allowLongPromptWhenExpensive: form.allowLongPromptWhenExpensive,
      longPromptThresholdChars: threshold,
      failureBehavior: form.failureBehavior,
      allowedCombos,
    },
    clientErrors: errors,
  };
}

function hasFormChanged(form: FormState, baseline: FormState): boolean {
  if (form.allowExpensiveModels !== baseline.allowExpensiveModels) return true;
  if (form.allowLongPromptWhenExpensive !== baseline.allowLongPromptWhenExpensive) return true;
  if (form.failureBehavior !== baseline.failureBehavior) return true;
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

const TIER_PILL_STYLES: Record<"standard" | "expensive" | "unknown", string> = {
  standard: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  expensive: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  unknown: "border-zinc-500/40 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
};

const TIER_PILL_LABELS: Record<"standard" | "expensive" | "unknown", string> = {
  standard: "Standard",
  expensive: "Expensive",
  unknown: "Unknown",
};

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
 * Small two-line "OK / Not OK" pill used inside the Model Registry to
 * keep OpenAI availability and Control Room support visually separate.
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
              data-testid={`${testIdPrefix}-${cap.key}`}
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
 * Tier badge for the registry row. Renders Standard / Expensive / Unknown
 * with a color matching the model's cost tier.
 */
const TierPill: FC<{ tier: "standard" | "expensive" | "unknown"; modelId: string }> = ({
  tier,
  modelId,
}) => {
  return (
    <span
      data-testid={`registry-tier-pill-${modelId}`}
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        TIER_PILL_STYLES[tier],
      )}
    >
      {TIER_PILL_LABELS[tier]}
    </span>
  );
};

/**
 * Inline warning shown next to the manual-selector toggle when the user is
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

/**
 * Helper: derive the (checked / disabled) state for the per-level
 * reasoning checkboxes for a single row. Pulled out so the row JSX
 * stays readable.
 */
function reasoningCellState(input: {
  configured: boolean;
  routerOn: boolean;
  level: ReasoningLevel;
  allowedComboKeys: Set<string>;
  modelId: string;
}): {
  checked: boolean;
  disabled: boolean;
} {
  const { configured, routerOn, level, allowedComboKeys, modelId } = input;
  if (!configured) {
    // Configured check should never let us get here (the row's router
    // toggle is locked for unconfigured models) but keep it as a
    // defense-in-depth branch.
    return { checked: false, disabled: true };
  }
  if (!routerOn) {
    return {
      checked: false,
      disabled: true,
    };
  }
  return {
    checked: allowedComboKeys.has(comboKey(modelId, level)),
    disabled: false,
  };
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

  // Registry UI state (sort + filter + search). The persisted selector
  // prefs are owned by the backend; this is purely client-side
  // presentation state so the user can find what they're looking for
  // without scrolling through 100+ ids.
  const [sortMode, setSortMode] = useState<RegistrySort>("configured-first");
  const [filterMode, setFilterMode] = useState<RegistryFilter>("all");
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

  const reasoningLevelsByModel = useMemo(() => {
    const m = new Map<string, ReadonlyArray<ReasoningLevel>>();
    for (const [modelId, entries] of registryByModel) {
      m.set(modelId, Array.from(new Set(entries.map((entry) => entry.reasoningLevel))));
    }
    return m;
  }, [registryByModel]);

  const registryEntries = useMemo(
    () =>
      (dto?.effectiveRegistry.models ?? []).filter((entry) =>
        providerFilter ? entry.providerId === providerFilter : true,
      ),
    [dto, providerFilter],
  );
  const selectorPrefs = useMemo(() => dto?.effectiveRegistry.selectorPrefs ?? {}, [dto]);
  const discovery = useMemo(() => dto?.effectiveRegistry.discovery, [dto]);
  const counts = useMemo(() => dto?.effectiveRegistry.counts, [dto]);

  /**
   * For each registry row, compute the router-toggle state and the
   * per-level checkbox state. Derived purely from the live
   * `form.allowedComboKeys` so toggling a single reasoning checkbox
   * updates the row's Router toggle immediately.
   */
  const registryRowState = useMemo(() => {
    const map = new Map<
      string,
      {
        routerOn: boolean;
        anyChecked: boolean;
        allChecked: boolean;
        checkedLevels: ReadonlyArray<ReasoningLevel>;
      }
    >();
    if (!form) return map;
    for (const entry of registryEntries) {
      const supported = reasoningLevelsByModel.get(entry.modelId) ?? [];
      const checkedLevels = supported.filter((lvl) =>
        form.allowedComboKeys.has(comboKey(entry.modelId, lvl)),
      );
      const anyChecked = checkedLevels.length > 0;
      const allChecked = supported.length > 0 && checkedLevels.length === supported.length;
      // "Router ON" for the row means at least one supported reasoning
      // level is currently in the allowlist. The brief: "Router ON →
      // router may recommend this model." That's satisfied as soon as
      // any one combo is checked.
      const routerOn = anyChecked && entry.configured;
      map.set(entry.modelId, {
        routerOn,
        anyChecked,
        allChecked,
        checkedLevels,
      });
    }
    return map;
  }, [registryEntries, form, reasoningLevelsByModel]);

  /**
   * Effective visible-set for the registry table, after applying
   * sort + filter + search. Persisted prefs are unchanged; this is
   * presentation-only.
   */
  const visibleRegistryEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const matchesSearch = (entry: EffectiveRegistryModelDto) =>
      q.length === 0 ||
      entry.modelId.toLowerCase().includes(q) ||
      entry.displayLabel.toLowerCase().includes(q);

    const prefVisible = (entry: EffectiveRegistryModelDto) => {
      const pref = selectorPrefs[entry.modelId]?.visible;
      return pref !== undefined ? pref : entry.manualSelectorVisible;
    };

    const matchesFilter = (entry: EffectiveRegistryModelDto): boolean => {
      switch (filterMode) {
        case "all":
          return true;
        case "configured":
          return entry.configured;
        case "not-configured":
          return !entry.configured;
        case "manual-enabled":
          return prefVisible(entry);
        case "router-enabled":
          return Boolean(registryRowState.get(entry.modelId)?.routerOn);
        case "available":
          return entry.available && !entry.stale;
        case "unavailable":
          return !entry.available || entry.stale;
      }
    };

    const filtered = registryEntries.filter((e) => matchesFilter(e) && matchesSearch(e));
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sortMode) {
        case "configured-first":
          // Configured first, then by router-eligibility, then
          // alphabetical.
          if (a.configured !== b.configured) return a.configured ? -1 : 1;
          const aRouter = Boolean(registryRowState.get(a.modelId)?.routerOn);
          const bRouter = Boolean(registryRowState.get(b.modelId)?.routerOn);
          if (aRouter !== bRouter) return aRouter ? -1 : 1;
          if (a.available !== b.available) return a.available ? -1 : 1;
          return a.modelId.localeCompare(b.modelId);
        case "unclassified-first":
          if (a.configured !== b.configured) return a.configured ? 1 : -1;
          if (a.available !== b.available) return a.available ? -1 : 1;
          return a.modelId.localeCompare(b.modelId);
        case "router-first": {
          const aRouter = Boolean(registryRowState.get(a.modelId)?.routerOn);
          const bRouter = Boolean(registryRowState.get(b.modelId)?.routerOn);
          if (aRouter !== bRouter) return aRouter ? -1 : 1;
          if (a.configured !== b.configured) return a.configured ? -1 : 1;
          return a.modelId.localeCompare(b.modelId);
        }
        case "available":
          if (a.available !== b.available) return a.available ? -1 : 1;
          return a.modelId.localeCompare(b.modelId);
      }
    });
    return sorted;
  }, [registryEntries, selectorPrefs, registryRowState, sortMode, filterMode, searchQuery]);

  const update = useCallback((patch: Partial<FormState>) => {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  /**
   * Toggle the row's Router switch. The semantics:
   *
   *   - Turn ON  (set every supported level into the allowlist).
   *   - Turn OFF (remove every supported level from the allowlist).
   *
   * This is the single-row equivalent of the previous "Check all" /
   * "Clear" buttons in the old router pool table.
   */
  const toggleRouterForModel = useCallback(
    (modelId: string, enabled: boolean) => {
      setForm((prev) => {
        if (!prev) return prev;
        const supported = reasoningLevelsByModel.get(modelId) ?? [];
        if (supported.length === 0) return prev;
        const next = new Set(prev.allowedComboKeys);
        for (const lvl of supported) {
          const k = comboKey(modelId, lvl);
          if (enabled) next.add(k);
          else next.delete(k);
        }
        return { ...prev, allowedComboKeys: next };
      });
    },
    [reasoningLevelsByModel],
  );

  /**
   * Toggle a single (model, reasoning-level) combo inside the allowlist.
   * Used by the per-level checkboxes in the Reasoning column.
   */
  const toggleReasoningCombo = useCallback(
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
          | {
              kind: "fresh";
              source: "openai" | "fake";
              modelCount: number;
              minimaxModelCount?: number;
            }
          | {
              kind: "cache_fresh";
              ageMs: number;
              modelCount: number;
              minimaxModelCount?: number;
            }
          | {
              kind: "failed";
              reason: string;
              usedCache: boolean;
              modelCount: number;
              minimaxModelCount?: number;
            };
      };
      if (data.outcome.kind === "fresh") {
        setRefreshStatus({
          kind: "refreshed",
          at: Date.now(),
          modelCount: data.outcome.modelCount,
          source: data.outcome.source,
          minimaxModelCount: data.outcome.minimaxModelCount ?? 0,
        });
      } else if (data.outcome.kind === "cache_fresh") {
        setRefreshStatus({
          kind: "refreshed",
          at: Date.now(),
          modelCount: data.outcome.modelCount,
          source: "cache_fresh",
          minimaxModelCount: data.outcome.minimaxModelCount ?? 0,
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

  /**
   * Persist manual-selector visibility for a single model.
   *
   * This endpoint is unchanged from the previous split-table layout:
   * `PUT /api/model-selector-prefs` writes the singleton prefs row.
   * The write happens immediately on toggle (the previous UX), not
   * batched into the router Save.
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
    <div
      className={cn(
        "flex w-full max-w-6xl flex-col gap-0 overflow-y-auto",
        embedded ? "" : "mx-auto h-dvh px-4 py-6 sm:px-8",
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
            Discover provider models (Section A), configure each model in a unified registry
            (Section B), and tune the OpenAI-only router&apos;s global safety knobs (Section C).
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
        {/* Section A: Provider Model Discovery */}
        <section
          aria-labelledby="discovery-heading"
          className="rounded-lg border border-border/60 bg-card p-4 sm:p-6"
          data-testid="router-settings-section-discovery"
        >
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 id="discovery-heading" className="text-sm font-semibold">
                A · Provider model discovery
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                OpenAI API models use <code className="rounded bg-muted px-1">OPENAI_API_KEY</code>
                and OpenAI API billing. Control Room calls OpenAI&apos;s{" "}
                <code className="rounded bg-muted px-1">/v1/models</code> to learn which model ids
                are available to that API key. MiniMax API models use{" "}
                <code className="rounded bg-muted px-1">MINIMAX_API_KEY</code> and a MiniMax token
                plan; the model id is env-file static for now and re-read from{" "}
                <code className="rounded bg-muted px-1">MINIMAX_DEFAULT_MODEL</code>.
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
              Refresh OpenAI + MiniMax models now
            </Button>
            {refreshStatus.kind === "refreshed" && (
              <span
                className="text-xs text-muted-foreground"
                data-testid="discovery-refresh-status"
              >
                Refreshed {formatRelativeAge(Date.now() - refreshStatus.at)} ({refreshStatus.source}
                , {refreshStatus.modelCount} OpenAI models, {refreshStatus.minimaxModelCount}{" "}
                MiniMax model).
              </span>
            )}
            {refreshStatus.kind === "refresh_error" && (
              <span className="text-xs text-destructive" data-testid="discovery-refresh-error">
                Refresh failed: {refreshStatus.message}
              </span>
            )}
          </div>
        </section>

        {/* Section B: Model Registry — unified table.
            Replaces the previous split "Manual Model Selector" +
            "Router Recommendation Pool" sections. Each row answers all
            six brief questions for a single model. */}
        <section
          aria-labelledby="registry-heading"
          className={cn(
            "rounded-lg border border-border/60 bg-card p-4 sm:p-6",
            errorsByField.has("allowedCombos") && "border-destructive/60",
          )}
          data-testid="router-settings-section-registry"
        >
          <div>
            <h2 id="registry-heading" className="text-sm font-semibold">
              B ·{" "}
              {providerFilter === "openai"
                ? "OpenAI API models"
                : providerFilter === "minimax"
                  ? "MiniMax API models"
                  : "Model registry"}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              One row per provider model. OpenAI API rows are direct API calls billed to OpenAI API
              usage; MiniMax API rows are direct MiniMax API calls using the MiniMax key/token plan.
              Toggle OpenAI model visibility in the chat composer (Manual), let the OpenAI-only
              router recommend eligible OpenAI models (Router), and pick which reasoning levels the
              router may pair with OpenAI models. MiniMax appears here for manual chat status but is
              not router-eligible yet.
            </p>
          </div>

          {selectorError && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <div>{selectorError}</div>
            </div>
          )}

          {/* Sort + filter + search controls. */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                type="text"
                placeholder="Search models by id or label…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                data-testid="registry-search"
                className="pl-8"
              />
            </div>
            <div className="flex items-center gap-1">
              <Filter className="size-3.5 text-muted-foreground/60" />
              <select
                aria-label="Filter"
                value={filterMode}
                onChange={(e) => setFilterMode(e.target.value as RegistryFilter)}
                data-testid="registry-filter"
                className="border-input bg-background flex h-9 rounded-md border px-2 text-xs shadow-xs outline-none"
              >
                <option value="all">All ({registryEntries.length})</option>
                <option value="configured">Configured only</option>
                <option value="not-configured">Not configured</option>
                <option value="manual-enabled">Manual enabled</option>
                <option value="router-enabled">Router enabled</option>
                <option value="available">Available from provider</option>
                <option value="unavailable">Unavailable</option>
              </select>
            </div>
            <div className="flex items-center gap-1">
              <ArrowUpDown className="size-3.5 text-muted-foreground/60" />
              <select
                aria-label="Sort"
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as RegistrySort)}
                data-testid="registry-sort"
                className="border-input bg-background flex h-9 rounded-md border px-2 text-xs shadow-xs outline-none"
              >
                <option value="configured-first">Configured first</option>
                <option value="unclassified-first">Unclassified first</option>
                <option value="router-first">Router first</option>
                <option value="available">Available first</option>
              </select>
            </div>
          </div>

          <div
            className="mt-2 text-xs text-muted-foreground/70"
            data-testid="registry-result-count"
          >
            Showing {visibleRegistryEntries.length} of {registryEntries.length} models
            {searchQuery ? ` matching “${searchQuery}”` : ""}
            {filterMode !== "all" ? ` (filter: ${filterMode})` : ""}.
          </div>

          <div
            className={cn(
              "mt-3 overflow-x-auto rounded-md border border-border/60",
              errorsByField.has("allowedCombos") && "border-destructive/60",
            )}
          >
            <table className="w-full min-w-[960px] text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground/70">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-medium" data-label="Model">
                    Model
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium" data-label="Provider">
                    Provider
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 text-left font-medium"
                    data-label="Control Room"
                  >
                    Control Room
                  </th>
                  <th scope="col" className="px-3 py-2 text-center font-medium" data-label="Manual">
                    Manual
                  </th>
                  <th scope="col" className="px-3 py-2 text-center font-medium" data-label="Router">
                    Router
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 text-center font-medium"
                    data-label="Reasoning"
                  >
                    Reasoning
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium" data-label="Tier">
                    Tier
                  </th>
                  <th
                    scope="col"
                    className="px-3 py-2 text-left font-medium"
                    data-label="Capabilities"
                  >
                    Capabilities
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {visibleRegistryEntries.length === 0 && (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-3 py-6 text-center text-xs text-muted-foreground/60"
                    >
                      No models match the current filter / search.
                    </td>
                  </tr>
                )}
                {visibleRegistryEntries.map((entry) => {
                  const prefVisible = selectorPrefs[entry.modelId]?.visible;
                  const defaultVisible = entry.manualSelectorVisible;
                  const manualVisible = prefVisible !== undefined ? prefVisible : defaultVisible;
                  // The server-computed `manuallyOverridden` only updates
                  // when we re-fetch the registry. For instant feedback
                  // after toggling, derive it from the local selector
                  // prefs map (which is updated optimistically on click).
                  const manuallyOverridden = prefVisible !== undefined || entry.manuallyOverridden;
                  const rowState = registryRowState.get(entry.modelId);
                  const routerOn = Boolean(rowState?.routerOn);
                  const anyChecked = Boolean(rowState?.anyChecked);
                  const allChecked = Boolean(rowState?.allChecked);
                  const saving = Boolean(selectorSaving[entry.modelId]);
                  const showInlineWarning =
                    manualVisible && !entry.configured && !warningDismissedFor[entry.modelId];
                  const manualToggleDisabled = saving || entry.providerId !== "openai";
                  const routerLocked =
                    entry.providerId !== "openai" ||
                    !entry.configured ||
                    entry.stale ||
                    !entry.supportsReasoning;
                  // Partial router toggle: the user has checked some but
                  // not all supported levels. Surfaced as a small badge
                  // next to the switch so the binary Switch state stays
                  // meaningful.
                  const isPartial = anyChecked && !allChecked;
                  return (
                    <tr
                      key={entry.modelId}
                      data-testid={`registry-row-${entry.modelId}`}
                      data-configured={entry.configured ? "true" : "false"}
                      data-stale={entry.stale ? "true" : "false"}
                      className={cn("transition-colors align-top", entry.stale && "bg-muted/20")}
                    >
                      {/* Model column */}
                      <td className="px-3 py-2">
                        <div className="font-medium">
                          {entry.providerId === "openai"
                            ? `OpenAI API · ${entry.displayLabel}`
                            : entry.displayLabel}
                        </div>
                        <div className="text-[11px] text-muted-foreground/70">{entry.modelId}</div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {!entry.configured && !entry.stale && (
                            <span
                              data-testid={`registry-badge-unclassified-${entry.modelId}`}
                              className="inline-flex items-center rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-rose-700 dark:text-rose-300"
                            >
                              unclassified
                            </span>
                          )}
                          {entry.provenance === "fake" && (
                            <span
                              data-testid={`registry-badge-fake-${entry.modelId}`}
                              className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300"
                            >
                              fake
                            </span>
                          )}
                          {entry.provenance === "env_static" && (
                            <span
                              data-testid={`registry-badge-env-static-${entry.modelId}`}
                              className="inline-flex items-center rounded-full border border-blue-500/40 bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300"
                            >
                              env
                            </span>
                          )}
                          {entry.provenance === "stale" && (
                            <span
                              data-testid={`registry-badge-stale-${entry.modelId}`}
                              className="inline-flex items-center rounded-full border border-zinc-500/40 bg-zinc-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-700 dark:text-zinc-300"
                            >
                              stale
                            </span>
                          )}
                          {manuallyOverridden && (
                            <span
                              data-testid={`registry-badge-overridden-${entry.modelId}`}
                              className="inline-flex items-center rounded-full border border-blue-500/40 bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300"
                            >
                              override
                            </span>
                          )}
                          {isPartial && (
                            <span
                              data-testid={`registry-badge-partial-${entry.modelId}`}
                              className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300"
                            >
                              partial
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Provider column */}
                      <td className="px-3 py-2" data-label="Provider">
                        <div className="flex flex-col gap-1">
                          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                            {entry.providerLabel}
                          </div>
                          <StatusPill
                            ok={entry.available}
                            okLabel="Available"
                            badLabel="Unavailable"
                            testId={`registry-provider-pill-${entry.modelId}`}
                          />
                          <span className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {entry.providerId === "openai"
                              ? "API billed"
                              : "MiniMax key · token plan"}
                          </span>
                          {entry.available ? (
                            <Eye className="size-3 text-emerald-600/60 dark:text-emerald-400/60" />
                          ) : (
                            <EyeOff className="size-3 text-zinc-500/60" />
                          )}
                        </div>
                      </td>

                      {/* Control Room column */}
                      <td className="px-3 py-2" data-label="Control Room">
                        <div className="flex flex-col gap-1">
                          <StatusPill
                            ok={entry.configured}
                            okLabel="Configured"
                            badLabel="Not configured"
                            testId={`registry-controlroom-pill-${entry.modelId}`}
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

                      {/* Manual toggle column */}
                      <td className="px-3 py-2 text-center" data-label="Manual">
                        <div className="flex flex-col items-center gap-1">
                          <Switch
                            checked={manualVisible}
                            disabled={manualToggleDisabled}
                            onCheckedChange={(v) => void onToggleSelectorVisible(entry.modelId, v)}
                            aria-label={`Show ${entry.displayLabel} in manual selector`}
                            data-testid={`registry-manual-toggle-${entry.modelId}`}
                          />
                          {showInlineWarning && (
                            <UnconfiguredWarning modelLabel={entry.displayLabel} />
                          )}
                        </div>
                      </td>

                      {/* Router toggle column */}
                      <td className="px-3 py-2 text-center" data-label="Router">
                        <TooltipProvider delayDuration={150}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span
                                className="inline-flex"
                                data-testid={`registry-router-locked-${entry.modelId}`}
                              >
                                {routerLocked ? (
                                  <span
                                    className="inline-flex items-center gap-1 rounded-md border border-zinc-500/40 bg-zinc-500/10 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-700 dark:text-zinc-300"
                                    aria-label="Router toggle locked"
                                  >
                                    <Lock className="size-3" />
                                    Disabled
                                  </span>
                                ) : (
                                  <Switch
                                    checked={routerOn}
                                    onCheckedChange={(v) => toggleRouterForModel(entry.modelId, v)}
                                    aria-label={`Allow router to recommend ${entry.displayLabel}`}
                                    data-testid={`registry-router-toggle-${entry.modelId}`}
                                  />
                                )}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {routerLocked
                                ? entry.providerId !== "openai"
                                  ? "Router A/B is currently only supported for OpenAI models."
                                  : entry.stale
                                    ? "This model disappeared from the latest OpenAI discovery. Refresh to re-enable."
                                    : !entry.supportsReasoning
                                      ? "This model has no supported reasoning levels and cannot be recommended by the router."
                                      : "This model has not yet been configured in Control Room and cannot be recommended by the router."
                                : routerOn
                                  ? "Router may recommend this model. Uncheck to stop the router from using it."
                                  : "Router will not recommend this model. Toggle on to allow it."}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </td>

                      {/* Reasoning column */}
                      <td className="px-3 py-2 text-center" data-label="Reasoning">
                        <div className="flex items-center justify-center gap-2">
                          {(reasoningLevelsByModel.get(entry.modelId) ?? []).length === 0 && (
                            <span className="text-[10px] text-muted-foreground/60">
                              Not supported
                            </span>
                          )}
                          {(reasoningLevelsByModel.get(entry.modelId) ?? []).map((level) => {
                            const cell = reasoningCellState({
                              configured: entry.configured && !entry.stale,
                              routerOn,
                              level,
                              allowedComboKeys: form.allowedComboKeys,
                              modelId: entry.modelId,
                            });
                            const cellTestId = `registry-reasoning-${entry.modelId}-${level}`;
                            return (
                              <div key={level} className="flex flex-col items-center gap-0.5">
                                <Checkbox
                                  checked={cell.checked}
                                  disabled={cell.disabled}
                                  onCheckedChange={(value) =>
                                    toggleReasoningCombo(entry.modelId, level, value === true)
                                  }
                                  aria-label={`Allow ${entry.displayLabel} with ${level} reasoning`}
                                  data-testid={cellTestId}
                                  className="size-3.5"
                                />
                                <span
                                  className={cn(
                                    "text-[9px] uppercase tracking-wide",
                                    cell.disabled
                                      ? "text-muted-foreground/40"
                                      : "text-muted-foreground/70",
                                  )}
                                >
                                  {level}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </td>

                      {/* Tier column */}
                      <td className="px-3 py-2" data-label="Tier">
                        <TierPill tier={entry.tier} modelId={entry.modelId} />
                      </td>

                      {/* Capabilities column */}
                      <td className="px-3 py-2" data-label="Capabilities">
                        <CapabilityList
                          capabilities={entry.capabilities}
                          testIdPrefix={`registry-capability-${entry.modelId}`}
                        />
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

          <p className="mt-3 text-xs text-muted-foreground/70">
            <strong>Provider</strong> = whether the provider/env config says this model can be
            called now. <strong>Control Room</strong> = whether this build has local metadata
            (display label, tier, reasoning levels) for it. <strong>Manual</strong> toggles OpenAI
            chat-composer visibility and saves immediately; MiniMax is env-file static for now.{" "}
            <strong>Router</strong> and <strong>Reasoning</strong> are OpenAI-only. Unconfigured
            models cannot enter the router pool, by design.
          </p>
        </section>

        {/* Section C: Router Global Settings — only the knobs that
            affect every router run. Everything model-specific has
            moved into the Model Registry above. */}
        <section
          aria-labelledby="failure-behavior-heading"
          className="rounded-lg border border-border/60 bg-card p-4 sm:p-6"
          data-testid="router-settings-section-failure-behavior"
        >
          <h2 id="failure-behavior-heading" className="text-sm font-semibold">
            C · Router global settings
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Model-specific knobs (Manual, Router, Reasoning) live in the Model Registry above. This
            section only holds router-wide safety controls.
          </p>

          <div className="mt-4 rounded-md border border-border/60 px-3 py-3">
            <Label htmlFor="failure-behavior">Failure behavior</Label>
            <p className="mt-1 text-xs text-muted-foreground">
              Choose what happens when the selected or router-recommended model/reasoning
              combination cannot run.
            </p>
            <select
              id="failure-behavior"
              data-testid="router-settings-failure-behavior"
              value={form.failureBehavior}
              onChange={(e) => update({ failureBehavior: e.target.value as RouterFailureBehavior })}
              className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 mt-3 flex h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px]"
            >
              <option value="fail_loud">Fail loud — stop and show a clear error</option>
              <option value="suggest_alternative">
                Suggest alternative — stop and require explicit approval
              </option>
              <option value="auto_fallback">
                Auto fallback — advanced, not recommended for evaluation
              </option>
            </select>
            <p className="mt-2 text-xs text-muted-foreground">
              Fail loud is the default. No alternative model is run unless auto fallback is
              explicitly selected.
            </p>
          </div>

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

          {!isExpensiveAllowed && registry.some((e) => e.tier === "expensive") && (
            <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              Expensive-tier combinations are disabled until you turn on &ldquo;Allow expensive
              models&rdquo; above. The router cannot pick an expensive combo unless that switch is
              on.
            </p>
          )}
        </section>
      </main>
    </div>
  );
};
