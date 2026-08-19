"use client";

import { Fragment, useCallback, useMemo, useState, type FC } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Filter, RotateCcw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import {
  BillingTag,
  CellTooltip,
  CellTooltipProvider,
  LockedChip,
  ReasoningCell,
  billingLabelFor,
  deriveStatus,
} from "./registry-helpers";
import type { EffectiveRegistryModelDto } from "./types";
import {
  describeReasoningCapability,
  getEffectiveReasoningLevels,
  getThinkingModeOptionValues,
} from "@/lib/providers/capability";

/**
 * Tab C — Recommender candidates.
 *
 *   "What may the recommender suggest?"
 *
 * Per-model controls that decide whether the recommender is allowed to
 * pick a given model, and which provider-native reasoning/thinking
 * options may be paired with it.
 *
 *   Columns: Model | Provider / Source | Status | Billing / Source
 *          | Allow recommender | Allowed reasoning / thinking options
 *
 * This is the only tab where reasoning/thinking checkboxes appear.
 * Per the brief:
 *
 *   - Toggle ON  → recommender may suggest this model.
 *   - Toggle OFF → recommender may NOT suggest this model.
 *   - Allowed options per-row constrain the recommender's pick.
 *   - The recommender must NOT suggest (model + reasoning) combos
 *     outside this allowed set.
 *   - These options do NOT constrain manual chat composer reasoning.
 *
 * The per-row reasoning options are the user-curated surface for
 * `settings.allowedCombos` (post split). On save, these flow through
 * `/api/router-settings` as the `allowedCombos` field, and the runtime
 * recommender consults the intersection of the model's capability and
 * this user allowlist before picking a reasoning level.
 *
 * Bulk actions exposed (per the brief):
 *   - Allow subscription standard models   (enabled → ON, candidates with
 *                                          subscription billing get
 *                                          auto-included)
 *   - Block API-billed models              (enabled → OFF for any OpenAI
 *                                          API row)
 *   - Block all                            (set allowlist to empty set)
 *   - Reset safe defaults                  (subscription-only defaults)
 */

type FilterValue =
  | "all"
  | "recommender-enabled"
  | "recommender-disabled"
  | "subscription"
  | "api-billed"
  | "available"
  | "unavailable";

type RecommenderCandidatesTabProps = {
  registry: ReadonlyArray<EffectiveRegistryModelDto>;
  /** User-curated model allowlist: `null` = no restriction, otherwise the explicit set. */
  modelAllowlist: ReadonlyArray<string> | null;
  /** User-curated per-(model, level) option allowlist. */
  allowedCombos: ReadonlyArray<{ modelId: string; reasoningLevel: string }>;
  /** Server-computed selector prefs (used to color the Status column the same way as Tab A). */
  selectorPrefs: Record<string, { visible: boolean }>;
  /** Toggle whether the recommender may pick this model. */
  onToggleRecommenderForModel: (modelId: string, enabled: boolean) => void;
  /** Toggle a single (model, level) reasoning/thinking option for the candidate pool. */
  onToggleReasoningCombo: (modelId: string, level: string, enabled: boolean) => void;
  /** Bulk actions. `null` setter clears / sets allowlist to null (no restriction). */
  onAllowSubscriptionStandard: () => void;
  onAllowAll: () => void;
  onBlockApiBilled: () => void;
  onBlockAll: () => void;
  onResetSafeDefaults: () => void;
  /** Number of candidates the recommender would actually be allowed to pick. */
  candidateCount: number;
  /** All errors from the most recent save. */
  fieldErrors?: ReadonlyArray<{ field: string; message: string }>;
  /** Test ID override; defaults to `router-settings-section-recommender-candidates`. */
  testId?: string;
};

export const RecommenderCandidatesTab: FC<RecommenderCandidatesTabProps> = ({
  registry,
  modelAllowlist,
  allowedCombos,
  selectorPrefs,
  onToggleRecommenderForModel,
  onToggleReasoningCombo,
  onAllowSubscriptionStandard,
  onAllowAll,
  onBlockApiBilled,
  onBlockAll,
  onResetSafeDefaults,
  candidateCount,
  fieldErrors = [],
  testId = "router-settings-section-recommender-candidates",
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [filterMode, setFilterMode] = useState<FilterValue>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const toggleCollapsed = useCallback((providerId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(providerId)) next.delete(providerId);
      else next.add(providerId);
      return next;
    });
  }, []);

  /**
   * Build the Set<modelId> from `modelAllowlist`. `null` = no
   * restriction — every enabled model is implicitly allowed.
   */
  const allowedSet = useMemo(
    () => (modelAllowlist === null ? null : new Set(modelAllowlist)),
    [modelAllowlist],
  );

  /**
   * Build the Set<comboKey> from `allowedCombos`. Used to derive the
   * checked state per-row per-level.
   */
  const allowedCombosByKey = useMemo(
    () => new Set(allowedCombos.map((c) => `${c.modelId}|${c.reasoningLevel}`)),
    [allowedCombos],
  );

  /**
   * Per-model native option set, merging the model's `effort_levels`
   * surface with the `thinking_budget` mode surface (for MiniMax M3).
   * Unknown capabilities expose an empty array — we never fake options
   * (the brief: "do not show fake low").
   */
  const nativeOptionsByModel = useMemo(() => {
    const map = new Map<string, ReadonlyArray<string>>();
    for (const entry of registry) {
      const cap = entry.reasoningCapability;
      if (
        cap.kind === "effort_levels" &&
        (cap.control === "supported" || cap.control === "model_dependent")
      ) {
        map.set(entry.modelId, getEffectiveReasoningLevels(cap));
        continue;
      }
      if (
        cap.kind === "thinking_budget" &&
        cap.modes &&
        (cap.control === "supported" || cap.control === "model_dependent")
      ) {
        const modes = getThinkingModeOptionValues(cap);
        if (modes.length > 0) {
          map.set(entry.modelId, modes);
          continue;
        }
        // MiniMax thinking-budget, supported but no modes
        // advertised — fall back to the well-known provider-native
        // names so the user can still pick.
        map.set(entry.modelId, ["provider_default", "adaptive", "enabled", "disabled"]);
        continue;
      }
      map.set(entry.modelId, []);
    }
    return map;
  }, [registry]);

  const filteredRegistry = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const matchesSearch = (entry: EffectiveRegistryModelDto): boolean =>
      q.length === 0 ||
      entry.modelId.toLowerCase().includes(q) ||
      entry.displayLabel.toLowerCase().includes(q);

    const recommenderAllowed = (entry: EffectiveRegistryModelDto): boolean =>
      allowedSet === null ? entry.configured && entry.available : allowedSet.has(entry.modelId);

    const matchesFilter = (entry: EffectiveRegistryModelDto): boolean => {
      switch (filterMode) {
        case "all":
          return true;
        case "recommender-enabled":
          return recommenderAllowed(entry);
        case "recommender-disabled":
          return !recommenderAllowed(entry);
        case "subscription":
          return entry.billingSource === "subscription";
        case "api-billed":
          return entry.billingSource === "api_billing";
        case "available":
          return entry.available && !entry.stale && entry.configured;
        case "unavailable":
          return !entry.available || entry.stale;
      }
    };
    return registry.filter((e) => matchesSearch(e) && matchesFilter(e));
  }, [registry, searchQuery, filterMode, allowedSet]);

  const groupedRegistry = useMemo(() => {
    const order = ["openai", "codex", "minimax"];
    const labelFor = (providerId: string): string =>
      providerId === "openai"
        ? "OpenAI API"
        : providerId === "codex"
          ? "Codex subscription"
          : providerId === "minimax"
            ? "MiniMax subscription"
            : providerId;
    const providerIds = [
      ...order.filter((id) => filteredRegistry.some((entry) => entry.providerId === id)),
      ...Array.from(new Set(filteredRegistry.map((entry) => entry.providerId))).filter(
        (id) => !order.includes(id),
      ),
    ];
    return providerIds.map((providerId) => ({
      providerId,
      label: labelFor(providerId),
      entries: filteredRegistry.filter((entry) => entry.providerId === providerId),
    }));
  }, [filteredRegistry]);

  const errorsByField = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of fieldErrors) map.set(e.field, e.message);
    return map;
  }, [fieldErrors]);

  return (
    <section
      aria-labelledby="recommender-candidates-heading"
      className={cn(
        "rounded-lg border border-border/60 bg-card p-4 sm:p-6",
        errorsByField.has("allowedCombos") && "border-destructive/60",
      )}
      data-testid={testId}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h2 id="recommender-candidates-heading" className="text-sm font-semibold">
            C · Recommender candidates
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Per-row controls for which models the recommender may suggest, and which provider-native
            reasoning/thinking options each model may be paired with. The recommender must never
            suggest a (model + reasoning) combination outside this allowed set.
          </p>
        </div>
        <div
          className="mt-3 flex flex-wrap items-center gap-1.5 rounded-md border border-border/60 bg-muted/10 px-3 py-2"
          data-testid="router-settings-recommender-allowlist"
        >
          <span
            className="rounded-full border border-border/60 bg-card px-2.5 py-0.5 text-[11px] text-muted-foreground"
            data-testid="router-settings-recommender-allowlist-summary"
          >
            {modelAllowlist === null
              ? `All enabled models (${candidateCount}) may be suggested.`
              : modelAllowlist.length === 0
                ? "No models are currently allowed for the recommender."
                : `${modelAllowlist.length} of ${candidateCount} enabled models may be suggested.`}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onAllowSubscriptionStandard}
            data-testid="router-settings-candidates-allow-subscription"
            aria-label="Allow subscription-backed standard models"
          >
            Allow subscription standard
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onBlockApiBilled}
            data-testid="router-settings-candidates-block-api-billed"
            aria-label="Block API-billed models from candidates"
          >
            Block API-billed
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onBlockAll}
            data-testid="router-settings-recommender-allowlist-block-all"
            aria-label="Block all models for the recommender"
          >
            Block all
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onAllowAll}
            data-testid="router-settings-recommender-allowlist-allow-all"
            aria-label="Allow all enabled models for the recommender"
          >
            Allow all enabled
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onResetSafeDefaults}
            data-testid="router-settings-candidates-reset-defaults"
            aria-label="Reset recommender candidates to safe defaults"
          >
            <RotateCcw className="size-3.5" />
            Reset safe defaults
          </Button>
        </div>
      </div>

      {/* Bulk-action explanation + API-billed warning. */}
      <div
        data-testid="router-settings-candidates-api-billed-warning"
        className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300"
      >
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <div>
          <strong>API-billed models are never used as fallback.</strong> The recommender can only
          suggest API-billed models after explicit approval.
        </div>
      </div>

      {/* Search + filter — same affordance the user already knows. */}
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
            aria-label="Filter recommender candidates"
            value={filterMode}
            onChange={(e) => setFilterMode(e.target.value as FilterValue)}
            data-testid="registry-filter"
            className="border-input bg-background flex h-9 rounded-md border px-2 text-xs shadow-xs outline-none"
          >
            <option value="all">All ({registry.length})</option>
            <option value="recommender-enabled">Recommender enabled</option>
            <option value="recommender-disabled">Recommender disabled</option>
            <option value="subscription">Subscription-backed</option>
            <option value="api-billed">API-billed</option>
            <option value="available">Available from provider</option>
            <option value="unavailable">Unavailable</option>
          </select>
        </div>
      </div>

      <div className="mt-2 text-xs text-muted-foreground/70" data-testid="registry-result-count">
        Showing {filteredRegistry.length} of {registry.length} models
        {searchQuery ? ` matching “${searchQuery}”` : ""}
        {filterMode !== "all" ? ` (filter: ${filterMode})` : ""}.
      </div>

      {fieldErrors.length > 0 && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div>
            <div className="font-medium">Save failed:</div>
            <ul className="mt-1 list-inside list-disc">
              {fieldErrors.map((e, idx) => (
                <li key={`${e.field}-${idx}`}>{e.message}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="mt-3 overflow-x-auto rounded-md border border-border/60">
        <table className="w-full min-w-[940px] text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground/70">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium" data-label="Model">
                Model
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-left font-medium"
                data-label="Provider / Source"
              >
                Provider / Source
              </th>
              <th scope="col" className="px-3 py-2 text-left font-medium" data-label="Status">
                Status
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-left font-medium"
                data-label="Billing / Source"
              >
                Billing / Source
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-center font-medium"
                data-label="Allow recommender"
              >
                Allow recommender
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-center font-medium"
                data-label="Allowed reasoning / thinking options"
              >
                Allowed reasoning / thinking options
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {filteredRegistry.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-xs text-muted-foreground/60">
                  No models match the current filter / search.
                </td>
              </tr>
            )}
            {groupedRegistry.map((group) => {
              const isCollapsed = collapsed.has(group.providerId);
              return (
                <Fragment key={group.providerId}>
                  <tr className="bg-muted/30">
                    <td colSpan={6} className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => toggleCollapsed(group.providerId)}
                        className="flex w-full items-center justify-between gap-3 text-left"
                        aria-expanded={!isCollapsed}
                        data-testid={`registry-provider-group-${group.providerId}`}
                      >
                        <span className="flex items-center gap-2 font-medium">
                          {isCollapsed ? (
                            <ChevronRight className="size-3.5" />
                          ) : (
                            <ChevronDown className="size-3.5" />
                          )}
                          {group.label}
                        </span>
                        <span className="text-[11px] text-muted-foreground/70">
                          {group.entries.length} models
                        </span>
                      </button>
                    </td>
                  </tr>
                  {!isCollapsed &&
                    group.entries.map((entry) => {
                      const pref = selectorPrefs[entry.modelId]?.visible;
                      const isPrefHidden = pref === false;
                      // The recommender can only pick from enabled +
                      // non-Codex gated-off models. Unconfigured or
                      // unavailable models show a locked Recommender
                      // chip.
                      const recommenderLocked = !entry.configured || !entry.available;
                      const checked =
                        !recommenderLocked &&
                        (allowedSet === null ? true : allowedSet.has(entry.modelId));
                      const nativeLevels = nativeOptionsByModel.get(entry.modelId) ?? [];
                      const status = deriveStatus(entry, pref);
                      return (
                        <tr
                          key={entry.modelId}
                          data-testid={`registry-row-${entry.modelId}`}
                          data-configured={entry.configured ? "true" : "false"}
                          data-stale={entry.stale ? "true" : "false"}
                          className={cn(
                            "transition-colors align-top",
                            entry.stale && "bg-muted/20",
                          )}
                        >
                          {/* Model */}
                          <td className="px-3 py-2">
                            <div className="font-medium">{entry.displayLabel}</div>
                            <div className="text-[11px] text-muted-foreground/70">
                              {entry.modelId}
                            </div>
                            {isPrefHidden && (
                              <span className="mt-1 inline-flex items-center rounded-full border border-zinc-500/40 bg-zinc-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-700 dark:text-zinc-300">
                                hidden from manual picker
                              </span>
                            )}
                          </td>

                          {/* Provider / Source */}
                          <td className="px-3 py-2" data-label="Provider / Source">
                            <div className="flex flex-col gap-1">
                              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                                {entry.providerLabel}
                              </div>
                              <span className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                {billingLabelFor(entry.providerId)}
                              </span>
                            </div>
                          </td>

                          {/* Status */}
                          <td className="px-3 py-2" data-label="Status">
                            <span
                              data-testid={`registry-status-pill-${entry.modelId}`}
                              className={cn(
                                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
                                status === "available"
                                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                  : status === "quota_exhausted"
                                    ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                                    : status === "not_configured"
                                      ? "border-zinc-500/40 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300"
                                      : "border-zinc-500/40 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
                              )}
                            >
                              {status === "available"
                                ? "Available"
                                : status === "quota_exhausted"
                                  ? "Quota exhausted"
                                  : status === "not_configured"
                                    ? "Not configured"
                                    : status === "hidden"
                                      ? "Hidden"
                                      : "Unavailable"}
                            </span>
                          </td>

                          {/* Billing / Source */}
                          <td className="px-3 py-2" data-label="Billing / Source">
                            <BillingTag
                              billingSource={entry.billingSource}
                              testId={`registry-billing-tag-${entry.modelId}`}
                            />
                          </td>

                          {/* Allow recommender */}
                          <td className="px-3 py-2 text-center" data-label="Allow recommender">
                            <CellTooltipProvider>
                              <CellTooltip
                                content={
                                  recommenderLocked
                                    ? !entry.configured
                                      ? "This model is not configured in Control Room and cannot be recommended."
                                      : "This model is not currently available and cannot be recommended."
                                    : checked
                                      ? "The recommender may suggest this model."
                                      : "The recommender will not suggest this model."
                                }
                              >
                                <span className="inline-flex">
                                  {recommenderLocked ? (
                                    <LockedChip
                                      testId={`registry-recommender-locked-${entry.modelId}`}
                                    />
                                  ) : (
                                    <Switch
                                      checked={checked}
                                      onCheckedChange={(v) =>
                                        onToggleRecommenderForModel(entry.modelId, v)
                                      }
                                      aria-label={`Allow recommender to suggest ${entry.displayLabel}`}
                                      data-testid={`registry-recommender-toggle-${entry.modelId}`}
                                    />
                                  )}
                                </span>
                              </CellTooltip>
                            </CellTooltipProvider>
                          </td>

                          {/* Allowed reasoning / thinking options */}
                          <td
                            className="px-3 py-2 text-center"
                            data-label="Allowed reasoning / thinking options"
                          >
                            {nativeLevels.length === 0 ? (
                              <span
                                className="text-[10px] text-muted-foreground/60"
                                data-testid={`registry-reasoning-${entry.modelId}-unknown`}
                              >
                                {entry.providerId === "minimax" &&
                                entry.reasoningCapability.kind === "thinking_budget"
                                  ? "Unknown / provider default"
                                  : describeReasoningCapability(entry.reasoningCapability)}
                              </span>
                            ) : (
                              <div
                                className="flex flex-wrap items-center justify-center gap-1.5"
                                data-testid={`registry-reasoning-row-${entry.modelId}`}
                              >
                                {nativeLevels.map((level) => {
                                  const key = `${entry.modelId}|${level}`;
                                  const cellChecked = allowedCombosByKey.has(key);
                                  // Disabled when the row's Allow
                                  // Recommender switch is OFF
                                  // (matches the brief's invariant:
                                  // reasoning options only constrain
                                  // the recommender, and only when the
                                  // model itself is in the pool).
                                  const cellDisabled = recommenderLocked || !checked;
                                  return (
                                    <ReasoningCell
                                      key={key}
                                      modelId={entry.modelId}
                                      level={level}
                                      checked={cellChecked}
                                      disabled={cellDisabled}
                                      onChange={(v) =>
                                        onToggleReasoningCombo(entry.modelId, level, v)
                                      }
                                    />
                                  );
                                })}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </Fragment>
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
          {errorsByField.get("allowedCombos")}
        </p>
      )}

      <p className="mt-3 text-[11px] text-muted-foreground/70">
        <strong className="font-medium">Policy</strong> — model + reasoning options here are the
        recommender&apos;s pick surface only. They do <em>not</em> constrain the manual chat
        composer reasoning picker (which is per-send in the chat composer itself). API-billed models
        are kept under explicit toggle — they are never a silent fallback.
      </p>
    </section>
  );
};
