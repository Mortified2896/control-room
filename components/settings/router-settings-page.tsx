"use client";

import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2, RotateCcw, Save } from "lucide-react";

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
 * Postgres. The page covers the brief's required surface:
 *
 *   - allowed router model + reasoning-level combinations  (checkboxes)
 *   - fallback model                                       (dropdown)
 *   - fallback reasoning level                             (dropdown)
 *   - allow expensive models                               (switch)
 *   - long prompt threshold                                (number input)
 *   - allow expensive models on long prompts               (switch)
 *
 * Pricing knobs (maxCostPerRecommendationUsd, maxCostPerAbRunUsd) and
 * the router model id are intentionally NOT exposed here — they remain
 * env-only until we have reliable pricing metadata.
 *
 * The component owns its own form state. Save sends a partial payload;
 * the API merges with the current effective settings and re-validates
 * with the strict save parser. Reload always re-fetches the latest
 * effective settings so the form reflects the live source of truth.
 */

type RegistryEntry = {
  modelId: string;
  modelLabel: string;
  reasoningLevel: ReasoningLevel;
  tier: "cheap" | "expensive";
};

type RouterSettingsDto = {
  effective: RouterSettings;
  defaults: RouterSettings;
  configured: boolean;
  registry: ReadonlyArray<RegistryEntry>;
};

type FormState = {
  allowedComboKeys: Set<string>;
  fallbackModelId: string;
  fallbackReasoningLevel: ReasoningLevel;
  allowExpensiveModels: boolean;
  allowLongPromptWhenExpensive: boolean;
  longPromptThresholdChars: string; // string so we can show "blank" cleanly
};

type FieldError = { field: string; message: string };

type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "error"; message: string };

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
  // Reject orphan selections: the user can only check combos that exist
  // in the current registry. We trim and dedupe server-side too, but
  // catching it here gives immediate feedback in the UI.
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

const REASONING_LEVELS: ReadonlyArray<ReasoningLevel> = ["low", "medium", "high"];

/**
 * Initial-load error state. Rendered when the DB is not configured or the
 * first GET /api/router-settings call throws. Kept as its own component so
 * the parent component never has to early-return mid-hook.
 */
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

/**
 * Loading state shown while the first GET /api/router-settings is in
 * flight. Trivially small; kept as its own component so the parent
 * component does not early-return before hooks finish.
 */
const LoadingPanel: FC = () => {
  return (
    <div className="mx-auto flex h-dvh w-full max-w-2xl items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      Loading router settings…
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

  // The "Fallback reasoning level" dropdown lists only levels that the
  // currently-selected fallback model supports — same UX as the chat
  // composer's reasoning-level picker. The actual snap-to-low behavior
  // lives in the `update` helper below; here we just enumerate options.
  const fallbackModelLevels = useMemo<ReadonlyArray<ReasoningLevel>>(() => {
    if (!form) return REASONING_LEVELS;
    const entries = registryByModel.get(form.fallbackModelId) ?? [];
    const supported = entries.map((e) => e.reasoningLevel);
    if (supported.length === 0) return REASONING_LEVELS;
    return supported;
  }, [form, registryByModel]);

  // Group registry entries by model so the UI can render each model as
  // its own row with reasoning-level columns.
  const registryByModelEntries = useMemo(() => {
    const out: Array<{
      modelId: string;
      modelLabel: string;
      tier: "cheap" | "expensive";
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
        levels: registry.filter((r) => r.modelId === e.modelId),
      });
    }
    return out;
  }, [registry]);

  const update = useCallback(
    (patch: Partial<FormState>) => {
      setForm((prev) => {
        if (!prev) return prev;
        const next = { ...prev, ...patch };
        // If the user picked a fallback model that does not support the
        // current reasoning level, snap to the first supported level so
        // the dropdown stays sane (mirrors the chat composer behavior).
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
      // Re-fetch to pull the canonical merged payload (covers the case
      // where the server substituted defaults for blank fields).
      const fresh = await fetch("/api/router-settings", { cache: "no-store" });
      if (fresh.ok) {
        const freshDto = (await fresh.json()) as RouterSettingsDto;
        setDto(freshDto);
        const next = initialForm(freshDto);
        setForm(next);
        setBaseline(next);
      } else {
        // Fall back to the PUT response payload if the re-fetch fails.
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

  // Early-return branches live AFTER all hooks are called. This keeps the
  // Rules of Hooks satisfied (the same hooks run in the same order on
  // every render, regardless of which branch we end up rendering).
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

  // For expensive-tier models we render the combo as disabled unless the
  // user has also flipped `allowExpensiveModels` on. We intentionally do
  // not auto-toggle the expensive switch when the user checks an expensive
  // combo — they must opt in explicitly (matches the brief's intent).
  const isExpensiveAllowed = form.allowExpensiveModels;

  return (
    <div className="mx-auto flex h-dvh w-full max-w-3xl flex-col gap-0 overflow-y-auto px-4 py-6 sm:px-8">
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
            Choose exactly which model + reasoning-level combinations the router is allowed to
            recommend for Side B. The router only ever picks from this allowlist — it never invents
            combos outside of what is checked below.
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
        {/* Section: Allowlist */}
        <section
          aria-labelledby="allowlist-heading"
          className={cn(
            "rounded-lg border border-border/60 bg-card p-4 sm:p-6",
            errorsByField.has("allowedCombos") && "border-destructive/60",
          )}
        >
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 id="allowlist-heading" className="text-sm font-semibold">
                Allowed combinations
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                The router picks one of the checked combinations below for Side B. Combinations are
                listed per model with the reasoning levels that model supports.
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
                  const disabledByTier = isExpensiveRow && !isExpensiveAllowed;
                  return (
                    <tr
                      key={row.modelId}
                      data-testid={`router-settings-row-${row.modelId}`}
                      className={cn("transition-colors", disabledByTier && "bg-muted/20")}
                    >
                      <td className="px-3 py-2 align-top">
                        <div className="font-medium">{row.modelLabel}</div>
                        <div className="text-[11px] text-muted-foreground/70">{row.modelId}</div>
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
                              disabled={disabledByTier}
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
                          disabled={disabledByTier}
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
              Expensive-tier combinations are disabled until you turn on “Allow expensive models”
              below. The router cannot pick an expensive combo unless that switch is on.
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
