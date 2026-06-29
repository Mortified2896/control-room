"use client";

import type { FC } from "react";
import { CheckCircle2, Eye, EyeOff, Info, XCircle, Lock } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { EffectiveRegistryModelDto } from "./types";

/**
 * Shared visual primitives used by all three new tabs on
 * `/settings/router`. These replace the column-level pills/headers from
 * the previous unified-registry table — the new tabs each show focused
 * subsets of these primitives and never combine all of them on a single
 * row.
 *
 * What we kept:
 *   - StatusPill (Available / Unavailable / Configured / Not configured)
 *   - Provider/Billing badge (Codex subscription, MiniMax subscription,
 *     OpenAI API billing)
 *   - Reasoning-cell Helpers (thinking-mode value as a checkbox cell)
 *
 * What we removed (per the brief):
 *   - STANDARD / EXPENSIVE tier pills — cost safety now comes from the
 *     user-curated allowlists in Tab C, not vague tier labels.
 *   - "Official Codex catalog" / "ENV" / "PARTIAL" / "May require Pro" /
 *     "capability source" / "refreshedAt" — moved behind per-row
 *     details later. The new tabs keep the row lean by hiding these
 *     behind an info disclosure.
 */

/**
 * Billing / source label rendered on every row. Mirrors the labels
 * the Settings page already emits on `/api/models` so the chat composer
 * and the Settings tabs tell the same story.
 *
 *   OpenAI API billing      (usage-billed, never a silent fallback)
 *   Codex subscription      (included / ChatGPT subscription)
 *   MiniMax subscription    (token plan / subscription)
 */
export function billingLabelFor(providerId: EffectiveRegistryModelDto["providerId"]): string {
  if (providerId === "openai") return "OpenAI API billing";
  if (providerId === "codex") return "Codex subscription";
  return "MiniMax subscription";
}

/**
 * Short billing-kind tag rendered next to each row's billing label.
 *
 *   - `subscription` → green
 *   - `api_billing`  → amber, with an explicit warning that this is
 *                       never a silent fallback.
 *
 * Kept terse on purpose; the chat composer owns the long-form copy
 * ("never a silent fallback under the no-API-billing-fallback
 * policy"), this row label is the at-a-glance discriminator.
 */
export const BillingTag: FC<{
  billingSource: "subscription" | "api_billing";
  testId?: string;
}> = ({ billingSource, testId }) => {
  const isSubscription = billingSource === "subscription";
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
        isSubscription
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      )}
    >
      {isSubscription ? "Subscription-backed" : "API-billed"}
    </span>
  );
};

/**
 * Runtime status pill. Five states the brief calls out explicitly:
 *   - Available         (green)         — provider said yes / catalogued
 *   - Quota exhausted   (amber)         — runtime quota hit (Codex today)
 *   - Unavailable       (zinc)          — provider said no / discovery missing
 *   - Not configured    (amber)         — Control Room has no metadata
 *   - Hidden            (zinc)          — user toggled it off in Tab A
 *
 * The pill is intentionally bigger than the per-cell checkboxes so
 * users can scan the table and find unhealthy rows quickly.
 */
export const StatusPill: FC<{
  status: "available" | "quota_exhausted" | "unavailable" | "not_configured" | "hidden";
  testId?: string;
}> = ({ status, testId }) => {
  const styles: Record<typeof status, string> = {
    available: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    quota_exhausted: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    unavailable: "border-zinc-500/40 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
    not_configured: "border-zinc-500/40 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
    hidden: "border-zinc-500/40 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
  };
  const label: Record<typeof status, string> = {
    available: "Available",
    quota_exhausted: "Quota exhausted",
    unavailable: "Unavailable",
    not_configured: "Not configured",
    hidden: "Hidden",
  };
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
        styles[status],
      )}
    >
      {status === "available" ? (
        <CheckCircle2 className="size-3" />
      ) : status === "quota_exhausted" ? (
        <Info className="size-3" />
      ) : (
        <XCircle className="size-3" />
      )}
      {label[status]}
    </span>
  );
};

/**
 * Derive the runtime status pill label from the registry's `available`
 * / `configured` / provider-level flags.
 *
 *   configured=false            → "Not configured"
 *   available=false + codex     → "Quota exhausted" (so the user can
 *                                  still find the row even when Codex
 *                                  runs out)
 *   available=false             → "Unavailable"
 *   pref.hidden===true          → "Hidden"
 *   otherwise                   → "Available"
 *
 * Codex in particular must surface "Quota exhausted" instead of being
 * deleted from the row — the brief explicitly says "Do not remove Codex
 * models from settings because of this. Treat Codex as configured /
 * catalogued but temporarily unavailable for runtime."
 */
export function deriveStatus(
  entry: EffectiveRegistryModelDto,
  prefVisible: boolean | undefined,
): "available" | "quota_exhausted" | "unavailable" | "not_configured" | "hidden" {
  if (prefVisible === false) return "hidden";
  if (!entry.configured) return "not_configured";
  if (!entry.available) {
    // Codex quota exhaustion is a runtime-availability flag, not a
    // "model does not exist" flag. Surface the distinction so users
    // understand the model is configured but unusable today.
    if (entry.providerId === "codex" && entry.stale === false) {
      return "quota_exhausted";
    }
    return "unavailable";
  }
  return "available";
}

/**
 * Disabled / locked chip rendered in place of a Switch when the row's
 * control is intentionally locked (unconfigured model, hidden provider,
 * not eligible for the current surface).
 *
 * The Lock icon + "Disabled" label is consistent across all three tabs
 * so users immediately recognize the affordance.
 */
export const LockedChip: FC<{ testId?: string; label?: string }> = ({
  testId,
  label = "Disabled",
}) => {
  return (
    <span
      data-testid={testId}
      className="inline-flex items-center gap-1 rounded-md border border-zinc-500/40 bg-zinc-500/10 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-700 dark:text-zinc-300"
      aria-label={`Toggle locked: ${label}`}
    >
      <Lock className="size-3" />
      {label}
    </span>
  );
};

/**
 * Inline availability icon used next to the Status column. Eye open =
 * available from provider; Eye off = not currently available.
 *
 * Kept small (3px) so it doesn't compete with the StatusPill label for
 * attention — these are visual texture, not the primary signal.
 */
export const AvailabilityIcon: FC<{ available: boolean }> = ({ available }) => {
  return available ? (
    <Eye className="size-3 text-emerald-600/60 dark:text-emerald-400/60" />
  ) : (
    <EyeOff className="size-3 text-zinc-500/60" />
  );
};

/**
 * Thinking-mode / reasoning-level checkbox cell. Used in Tab C's
 * "Allowed reasoning/thinking options" column.
 *
 *   checked + enabled  → user has explicitly allowed this option
 *   unchecked          → not in the Tab C allowlist for this model
 *   disabled           → either the model doesn't support the option,
 *                        or the row's Recommender toggle is off
 *
 * The label is the provider-native value (e.g. "xhigh", "adaptive"),
 * rendered verbatim per the brief's "no fake low" rule.
 */
export const ReasoningCell: FC<{
  modelId: string;
  level: string;
  checked: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}> = ({ modelId, level, checked, disabled, onChange }) => {
  const cellTestId = `registry-reasoning-${modelId}-${level}`;
  return (
    <div className="flex flex-col items-center gap-0.5" data-label={`reasoning-${level}`}>
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
        aria-label={`Allow ${modelId} with ${level} reasoning`}
        data-testid={cellTestId}
        className="size-3.5"
      />
      <span
        className={cn(
          "text-[9px] uppercase tracking-wide",
          disabled ? "text-muted-foreground/40" : "text-muted-foreground/70",
        )}
      >
        {level}
      </span>
    </div>
  );
};

/**
 * Wrapper that provides a consistent Radix Tooltip setup so each row's
 * locked-chip / switch / checkbox can render its own tooltip without
 * redeclaring the provider.
 */
export const CellTooltipProvider: FC<{ children: React.ReactNode }> = ({ children }) => {
  return <TooltipProvider delayDuration={150}>{children}</TooltipProvider>;
};

export const CellTooltip: FC<{ content: React.ReactNode; children: React.ReactNode }> = ({
  content,
  children,
}) => {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{content}</TooltipContent>
    </Tooltip>
  );
};
