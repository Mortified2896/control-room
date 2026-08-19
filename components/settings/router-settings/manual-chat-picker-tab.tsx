"use client";

import { Fragment, useCallback, useMemo, useState, type FC } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Filter,
  Info,
  Loader2,
  RotateCcw,
  Search,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import { BillingTag, StatusPill, billingLabelFor, deriveStatus } from "./registry-helpers";
import type { EffectiveRegistryModelDto } from "./types";

/**
 * Tab A — Manual chat picker.
 *
 *   "What can I manually select?"
 *
 * Simplified table that answers exactly one question per row: is this
 * model visible in `/api/models` and the chat composer?
 *
 *   Columns: Model | Provider / Source | Status | Billing / Source | Show in manual picker
 *
 * Importantly, this tab does NOT show reasoning checkboxes. The chat
 * composer picks reasoning level inline (per send), not in Settings —
 * this tab must not overload that decision surface.
 *
 * Persistence: this tab writes through `/api/model-selector-prefs`
 * (separate singleton row), toggling saves immediately the way the old
 * registry table did. The Save button at the page level does NOT need
 * to be enabled for picker changes (those flush on click).
 *
 * What this tab deliberately removes (per the brief):
 *   - Tier column (STANDARD/EXPENSIVE pills)
 *   - Reasoning checkboxes (live in Tab C)
 *   - Router toggle (lives in Tab C)
 *   - Recommender toggle (lives in Tab C)
 *   - Capability placeholders (future per-row details)
 *
 * What this tab keeps:
 *   - Manual-selector visibility toggle (the one and only column)
 *   - Search + filter controls (Configurable / Hidden / Available / etc.)
 *   - Provider-grouped rows (Codex subscription / MiniMax subscription /
 *     OpenAI API) for the at-a-glance mental model
 *   - Inline warning when the user toggles an unconfigured model on
 *     (matches the brief's "may not be safe" mental model)
 */

type FilterValue = "all" | "visible" | "hidden" | "available" | "unavailable" | "not-configured";

type ManualChatPickerTabProps = {
  registry: ReadonlyArray<EffectiveRegistryModelDto>;
  /**
   * Map of modelId → { visible: boolean } from
   * `/api/model-selector-prefs`. Missing keys are treated as "default
   * visible" for configured + available models, "default hidden" for
   * unconfigured / stale models.
   */
  selectorPrefs: Record<string, { visible: boolean }>;
  /** Currently-saving per-row requests, keyed by modelId. */
  saving: Record<string, boolean>;
  /** Last per-row save error, if any. */
  saveError: string | null;
  /** Persist a single row's visibility flip; returns when the PUT resolves. */
  onToggle: (modelId: string, visible: boolean) => Promise<void> | void;
  /** Default visibility for the row computed server-side. */
  defaultVisibleFor: (entry: EffectiveRegistryModelDto) => boolean;
  /**
   * Called when the user clicks the top-level "Show all / hide all /
   * reset" bulk buttons. Persistent: writes once via /api/model-selector-prefs.
   */
  onBulkSetAllVisible: (visible: boolean) => Promise<void> | void;
  /** `true` while a bulk action is in flight (disables the buttons). */
  bulkSaving?: boolean;
  /** Test ID override; defaults to `router-settings-section-manual-picker`. */
  testId?: string;
};

export const ManualChatPickerTab: FC<ManualChatPickerTabProps> = ({
  registry,
  selectorPrefs,
  saving,
  saveError,
  onToggle,
  defaultVisibleFor,
  onBulkSetAllVisible,
  bulkSaving = false,
  testId = "router-settings-section-manual-picker",
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [filterMode, setFilterMode] = useState<FilterValue>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [dismissedWarning, setDismissedWarning] = useState<Record<string, boolean>>({});

  const toggleCollapsed = useCallback((providerId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(providerId)) next.delete(providerId);
      else next.add(providerId);
      return next;
    });
  }, []);

  /**
   * Effective visibility for a row, applying `selectorPrefs` on top of
   * the server-computed default. This is the same logic the chat
   * composer uses (see `getEffectiveModelsResponse`), kept inline so
   * the Tab A table can filter / pill without re-fetching.
   */
  const visibilityFor = useCallback(
    (entry: EffectiveRegistryModelDto): boolean => {
      const pref = selectorPrefs[entry.modelId]?.visible;
      return pref !== undefined ? pref : defaultVisibleFor(entry);
    },
    [selectorPrefs, defaultVisibleFor],
  );

  const filteredRegistry = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const matchesSearch = (entry: EffectiveRegistryModelDto): boolean =>
      q.length === 0 ||
      entry.modelId.toLowerCase().includes(q) ||
      entry.displayLabel.toLowerCase().includes(q);

    const matchesFilter = (entry: EffectiveRegistryModelDto): boolean => {
      const visible = visibilityFor(entry);
      switch (filterMode) {
        case "all":
          return true;
        case "visible":
          return visible;
        case "hidden":
          return !visible;
        case "available":
          return entry.available && !entry.stale && entry.configured;
        case "unavailable":
          return !entry.available || entry.stale;
        case "not-configured":
          return !entry.configured;
      }
    };

    return registry.filter((e) => matchesSearch(e) && matchesFilter(e));
  }, [registry, searchQuery, filterMode, visibilityFor]);

  /**
   * Group the filtered registry by provider for the at-a-glance
   * "Codex subscription" / "MiniMax subscription" / "OpenAI API
   * billing" sections. The collapsible group header mirrors the old
   * registry table's pattern so the new tabs feel familiar.
   */
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

  const totalVisible = useMemo(() => {
    return registry.reduce((acc, entry) => (visibilityFor(entry) ? acc + 1 : acc), 0);
  }, [registry, visibilityFor]);

  return (
    <section
      aria-labelledby="manual-picker-heading"
      className="rounded-lg border border-border/60 bg-card p-4 sm:p-6"
      data-testid={testId}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="manual-picker-heading" className="text-sm font-semibold">
            A · Manual chat picker
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Controls which models appear in the chat composer dropdown and in{" "}
            <code className="rounded bg-muted px-1">/api/models</code>. Toggle a model OFF to hide
            it from manual chat; the recommender is unaffected by this tab.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="text-[11px] text-muted-foreground"
            data-testid="manual-picker-visible-count"
          >
            {totalVisible} of {registry.length} models visible
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void onBulkSetAllVisible(true)}
            disabled={bulkSaving}
            data-testid="manual-picker-show-all"
          >
            Show all
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void onBulkSetAllVisible(false)}
            disabled={bulkSaving}
            data-testid="manual-picker-hide-all"
          >
            Hide all
          </Button>
        </div>
      </div>

      {/* Search + filter — same affordance the old registry table used. */}
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
            aria-label="Filter manual picker"
            value={filterMode}
            onChange={(e) => setFilterMode(e.target.value as FilterValue)}
            data-testid="registry-filter"
            className="border-input bg-background flex h-9 rounded-md border px-2 text-xs shadow-xs outline-none"
          >
            <option value="all">All</option>
            <option value="visible">Visible</option>
            <option value="hidden">Hidden</option>
            <option value="available">Available from provider</option>
            <option value="unavailable">Unavailable</option>
            <option value="not-configured">Not configured</option>
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSearchQuery("")}
            data-testid="registry-search-clear"
          >
            <RotateCcw className="size-3.5" />
            Clear search
          </Button>
        </div>
      </div>

      <div className="mt-2 text-xs text-muted-foreground/70" data-testid="registry-result-count">
        Showing {filteredRegistry.length} of {registry.length} models
        {searchQuery ? ` matching “${searchQuery}”` : ""}
        {filterMode !== "all" ? ` (filter: ${filterMode})` : ""}.
      </div>

      {saveError && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div>{saveError}</div>
        </div>
      )}

      <div className="mt-3 overflow-x-auto rounded-md border border-border/60">
        <table className="w-full min-w-[840px] text-sm">
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
                data-label="Show in manual picker"
              >
                Show in manual picker
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {filteredRegistry.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-xs text-muted-foreground/60">
                  No models match the current filter / search.
                </td>
              </tr>
            )}
            {groupedRegistry.map((group) => {
              const isCollapsed = collapsed.has(group.providerId);
              return (
                <Fragment key={group.providerId}>
                  <tr className="bg-muted/30">
                    <td colSpan={5} className="px-3 py-2">
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
                      const visible = visibilityFor(entry);
                      const defaultVisible = defaultVisibleFor(entry);
                      const overridden = visible !== defaultVisible;
                      const isSaving = Boolean(saving[entry.modelId]);
                      const status = deriveStatus(entry, selectorPrefs[entry.modelId]?.visible);
                      const showInlineWarning =
                        visible && !entry.configured && !dismissedWarning[entry.modelId];
                      return (
                        <tr
                          key={entry.modelId}
                          data-testid={`registry-row-${entry.modelId}`}
                          data-configured={entry.configured ? "true" : "false"}
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
                            {overridden && (
                              <span
                                data-testid={`registry-badge-overridden-${entry.modelId}`}
                                className="mt-1 inline-flex items-center rounded-full border border-blue-500/40 bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300"
                              >
                                override
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
                            <div className="flex items-center gap-1">
                              <StatusPill
                                status={status}
                                testId={`registry-status-pill-${entry.modelId}`}
                              />
                              {entry.available ? (
                                <Eye className="size-3 text-emerald-600/60 dark:text-emerald-400/60" />
                              ) : (
                                <EyeOff className="size-3 text-zinc-500/60" />
                              )}
                            </div>
                          </td>

                          {/* Billing / Source */}
                          <td className="px-3 py-2" data-label="Billing / Source">
                            <BillingTag
                              billingSource={entry.billingSource}
                              testId={`registry-billing-tag-${entry.modelId}`}
                            />
                            <div className="mt-1 text-[11px] text-muted-foreground/70">
                              {entry.providerId === "openai"
                                ? "OpenAI API billing"
                                : entry.providerId === "codex"
                                  ? "Codex subscription"
                                  : "MiniMax subscription"}
                            </div>
                          </td>

                          {/* Show in manual picker */}
                          <td className="px-3 py-2 text-center" data-label="Show in manual picker">
                            <div className="flex flex-col items-center gap-1">
                              {isSaving ? (
                                <Loader2
                                  className="size-4 animate-spin text-muted-foreground/60"
                                  data-testid={`manual-picker-saving-${entry.modelId}`}
                                />
                              ) : (
                                <Switch
                                  checked={visible}
                                  onCheckedChange={(v) => void onToggle(entry.modelId, v)}
                                  aria-label={`Show ${entry.displayLabel} in manual picker`}
                                  data-testid={`registry-manual-toggle-${entry.modelId}`}
                                />
                              )}
                              {showInlineWarning && (
                                <div
                                  className="mt-1 max-w-[260px] rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[10px] text-amber-700 dark:text-amber-300"
                                  role="note"
                                >
                                  <div className="flex items-start gap-1.5">
                                    <Info className="mt-0.5 size-3 shrink-0" />
                                    <div>
                                      <div className="font-medium">
                                        Not configured in Control Room
                                      </div>
                                      <div className="text-amber-700/80 dark:text-amber-300/80">
                                        {entry.displayLabel} has not yet been configured in Control
                                        Room. Reasoning-level support is unknown.
                                      </div>
                                      <button
                                        type="button"
                                        className="mt-1 text-[10px] underline"
                                        onClick={() =>
                                          setDismissedWarning((d) => ({
                                            ...d,
                                            [entry.modelId]: true,
                                          }))
                                        }
                                      >
                                        Dismiss
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
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

      <p className="mt-3 text-[11px] text-muted-foreground/70">
        <strong className="font-medium">Save</strong> — toggling a row persists immediately via{" "}
        <code className="rounded bg-muted px-1">/api/model-selector-prefs</code>. The page-level
        Save button at the top of the Settings page is for the recommender engine + candidates tabs
        (Tabs B and C).
      </p>
      <p
        className="mt-3 text-[11px] text-muted-foreground/70"
        data-testid="manual-picker-no-save-banner"
      >
        <strong className="font-medium">Policy</strong> — Codex rows remain visible when their
        runtime quota is exhausted. Treat{" "}
        <code className="rounded bg-muted px-1">Quota exhausted</code> as configured but temporarily
        unavailable.
      </p>
    </section>
  );
};

/**
 * Why the row has no <Save> here: the Manual picker toggle persists
 * immediately (legacy behavior — the brief explicitly preserves it).
 * Users can flip many toggles in a row without a single Save click.
 */
