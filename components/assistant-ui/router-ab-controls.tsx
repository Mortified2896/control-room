"use client";

import { ChevronDown, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type FC } from "react";

import { Dialog as DialogPrimitive } from "radix-ui";
import { useMediaQuery } from "@/components/layout/use-media-query";
import { KbdHint } from "@/components/kbd-hint";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ThinkingMode } from "@/lib/providers/runtime";
import type { ReasoningCapability } from "@/lib/providers/capability";
import {
  RecommenderModelSelector,
  type RecommenderModelOption,
} from "@/components/assistant-ui/recommender-model-selector";
import { getProviderNativeOptionChoices } from "@/lib/providers/capability";

/**
 * Reasoning-level picker.
 *
 * Renders next to the existing ModelSelector. Lists only the levels the
 * currently-selected model supports (so a model with no `medium` support
 * hides the `medium` option). Defaults to `low` when the user has not
 * picked anything yet.
 *
 * The A/B toggle controls whether the recommender runs; this dropdown
 * controls what Side A uses. The brief is explicit that Side A must
 * always use the user's selected combo — so this control is always
 * visible regardless of the A/B toggle state.
 */
export const ReasoningLevelSelect: FC<{
  value: string;
  options: ReadonlyArray<{ value: string; label?: string; description?: string }>;
  onChange: (level: string) => void;
}> = ({ value, options, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isPhone = useMediaQuery("(max-width: 639px)");

  useEffect(() => {
    if (isPhone) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isPhone]);

  const disabled = options.length === 0;

  // Render each option with its raw provider-native value as the
  // primary label (never renames "xhigh" to "High" or hides
  // "none" / "minimal"). When the option carries an explicit
  // `label`, render it as a secondary hint instead of replacing the
  // raw value — the raw value remains visible.
  const optionButtons = options.map((option) => {
    const isSelected = option.value === value;
    const displayLabel = option.label ?? option.value;
    const displaySubtitle = option.description ?? labelFor(option.value);
    return (
      <button
        key={option.value}
        type="button"
        data-reasoning-level={option.value}
        onClick={() => {
          onChange(option.value);
          setOpen(false);
        }}
        className={cn(
          "flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors sm:min-h-0 sm:py-1.5",
          isSelected
            ? "bg-accent text-accent-foreground"
            : "text-popover-foreground hover:bg-accent/50 hover:text-accent-foreground",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{displayLabel}</div>
          <div className="truncate text-[10px] text-muted-foreground">{displaySubtitle}</div>
        </div>
      </button>
    );
  });

  // Trigger label shows the raw provider-native value too. We do
  // NOT capitalize or relabel it — `xhigh` stays `xhigh` and
  // `none` stays `none`.
  const selected = options.find((o) => o.value === value);
  const triggerLabel = selected?.label ?? value;

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        type="button"
        data-testid="model-reasoning-select"
        data-current-reasoning={value}
        onClick={() => {
          if (!disabled) setOpen((prev) => !prev);
        }}
        aria-label={`Select reasoning level (currently ${value})`}
        aria-expanded={open}
        disabled={disabled}
        className={cn(
          "inline-flex min-h-10 max-w-full items-center gap-1.5 rounded-md border border-border/50 bg-muted/20 py-1 pl-2.5 pr-7 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:bg-muted/40 hover:text-foreground sm:min-h-0 sm:pr-9",
          disabled && "cursor-not-allowed opacity-60",
        )}
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronDown className="size-3 shrink-0 opacity-70" />
      </button>

      {open && !isPhone && (
        <div
          data-testid="model-reasoning-dropdown"
          className="absolute left-0 top-full z-50 mt-1 max-h-80 w-48 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md"
        >
          {optionButtons}
        </div>
      )}

      <DialogPrimitive.Root open={open && isPhone} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <DialogPrimitive.Content className="fixed inset-x-0 bottom-0 z-50 max-h-[70dvh] overflow-hidden rounded-t-2xl border border-border bg-popover shadow-lg outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom">
            <div className="safe-bottom flex max-h-[70dvh] flex-col">
              <div className="border-b border-border/60 px-4 py-3">
                <DialogPrimitive.Title className="text-sm font-semibold text-popover-foreground">
                  Reasoning level
                </DialogPrimitive.Title>
                <DialogPrimitive.Description className="mt-1 text-xs text-muted-foreground">
                  Choose how much reasoning effort the model should use.
                </DialogPrimitive.Description>
              </div>
              <div className="overflow-y-auto py-1">{optionButtons}</div>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
};

function labelFor(level: string): string {
  // Helper copy for the legacy OpenAI-style low/medium/high
  // values. For non-legacy provider-native values (`xhigh`,
  // `none`, `minimal`, …) we fall back to a neutral descriptor —
  // the picker still surfaces the raw value as the primary label.
  switch (level) {
    case "low":
      return "Faster, cheaper answers.";
    case "medium":
      return "Balanced speed and depth.";
    case "high":
      return "Slowest, deepest reasoning.";
    case "xhigh":
      return "Slowest, deepest reasoning (extra high).";
    case "minimal":
      return "Minimal reasoning effort.";
    case "none":
      return "No reasoning — model answers directly.";
    default:
      return `Provider-native reasoning option (${level}).`;
  }
}

/**
 * Thinking-mode picker — used for models with a `thinking_budget`
 * capability (MiniMax M3, future Anthropic-style thinking blocks).
 *
 * The three options map directly to the runtime `ThinkingMode` type:
 *
 *   - `Provider default` — do not pass any reasoning/thinking field;
 *     the provider decides.
 *   - `Enabled`           — request extended thinking.
 *   - `Disabled`          — request no extended thinking.
 *
 * When the capability is `kind: "thinking_budget"` with
 * `control: "model_dependent"` or `"unknown"`, we still render the
 * picker so the user has something to click, but we disable the
 * non-default options and surface a tooltip explaining that the
 * exact surface is unknown — the runtime adapter will not silently
 * ship `enabled: true` in that case.
 */
export const ThinkingModeSelect: FC<{
  value: ThinkingMode;
  onChange: (mode: ThinkingMode) => void;
  capability: Extract<ReasoningCapability, { kind: "thinking_budget" }>;
}> = ({ value, onChange, capability }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isPhone = useMediaQuery("(max-width: 639px)");

  useEffect(() => {
    if (isPhone) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isPhone]);

  // The capability's `modes` list carries the provider-native mode
  // values. We render them verbatim — `provider_default`, `enabled`,
  // `disabled`, `adaptive`, or any future provider-native value.
  // When the capability is `control: "unknown"` the picker still
  // renders the (empty) `modes` list so the UI shows "no known
  // options" rather than fake options.
  const advertisedModes = capability.modes ?? [];
  const trustedControl =
    capability.control === "supported" || capability.control === "model_dependent";

  type DisplayedOption = {
    value: ThinkingMode;
    label: string;
    description: string;
    disabled: boolean;
    tooltip?: string;
  };

  // Build a default fallback list when the capability does not
  // advertise modes but is still `trusted`. This keeps the picker
  // useful for capability rows that ship `supportsEnabled: true`
  // without an explicit `modes` array (e.g. future Anthropic-style
  // thinking blocks).
  const fallbackModes: ReadonlyArray<{ value: ThinkingMode; label: string; description: string }> =
    trustedControl
      ? [
          {
            value: "provider_default",
            label: "Provider default",
            description: "Let the model pick its own reasoning behavior.",
          },
          {
            value: "enabled",
            label: "Enabled",
            description: "Request extended thinking.",
          },
          {
            value: "disabled",
            label: "Disabled",
            description: "Turn off extended thinking.",
          },
        ]
      : [];

  const baseList = advertisedModes.length > 0 ? advertisedModes : fallbackModes;
  const explicitOptionsEnabled =
    capability.control === "supported" && capability.supportsEnabled !== false;

  const options: DisplayedOption[] = baseList.map((m) => {
    const valueStr = m.value;
    const label = m.label ?? valueStr;
    const description = m.description ?? "";
    // The runtime adapter only translates the well-known "enabled"
    // and "disabled" values into the MiniMax wire shape. For any
    // other mode (`"adaptive"`, etc.), the runtime omits the
    // payload and lets the provider decide — we still render the
    // option but flag the pick as trusted-only.
    const isExplicitWire = valueStr === "enabled" || valueStr === "disabled";
    const disabled = !explicitOptionsEnabled && isExplicitWire;
    const tooltip = disabled
      ? "This model's reasoning controls are model-dependent — the runtime cannot reliably force extended thinking on or off without documentation. Pick Provider default instead."
      : undefined;
    return {
      value: valueStr,
      label,
      description,
      disabled,
      ...(tooltip ? { tooltip } : {}),
    };
  });

  const selected = options.find((o) => o.value === value) ?? options[0];

  const optionButtons = options.map((opt) => {
    const isSelected = opt.value === value;
    return (
      <button
        key={opt.value}
        type="button"
        data-thinking-mode={opt.value}
        disabled={opt.disabled}
        title={opt.tooltip}
        onClick={() => {
          if (opt.disabled) return;
          onChange(opt.value);
          setOpen(false);
        }}
        className={cn(
          "flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors sm:min-h-0 sm:py-1.5",
          opt.disabled
            ? "cursor-not-allowed text-muted-foreground/50"
            : isSelected
              ? "bg-accent text-accent-foreground"
              : "text-popover-foreground hover:bg-accent/50 hover:text-accent-foreground",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{opt.label}</div>
          <div className="truncate text-[10px] text-muted-foreground">{opt.description}</div>
        </div>
      </button>
    );
  });

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        type="button"
        data-testid="model-thinking-mode-select"
        data-current-thinking-mode={value}
        onClick={() => setOpen((prev) => !prev)}
        aria-label={`Select thinking mode (currently ${selected?.label ?? value})`}
        aria-expanded={open}
        className="inline-flex min-h-10 max-w-full items-center gap-1.5 rounded-md border border-border/50 bg-muted/20 py-1 pl-2.5 pr-7 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:bg-muted/40 hover:text-foreground sm:min-h-0 sm:pr-9"
      >
        <span className="truncate">Thinking: {selected?.label ?? value}</span>
        <ChevronDown className="size-3 shrink-0 opacity-70" />
      </button>

      {open && !isPhone && (
        <div
          data-testid="model-thinking-mode-dropdown"
          className="absolute left-0 top-full z-50 mt-1 max-h-80 w-56 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md"
        >
          {optionButtons}
        </div>
      )}

      <DialogPrimitive.Root open={open && isPhone} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <DialogPrimitive.Content className="fixed inset-x-0 bottom-0 z-50 max-h-[70dvh] overflow-hidden rounded-t-2xl border border-border bg-popover shadow-lg outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom">
            <div className="safe-bottom flex max-h-[70dvh] flex-col">
              <div className="border-b border-border/60 px-4 py-3">
                <DialogPrimitive.Title className="text-sm font-semibold text-popover-foreground">
                  Thinking mode
                </DialogPrimitive.Title>
                <DialogPrimitive.Description className="mt-1 text-xs text-muted-foreground">
                  Choose how the model should use extended thinking. &ldquo;Provider default&rdquo;
                  lets the model pick its own reasoning behavior.
                </DialogPrimitive.Description>
              </div>
              <div className="overflow-y-auto py-1">{optionButtons}</div>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
};

/**
 * Capability-aware reasoning/thinking control surface for the chat
 * composer.
 *
 * Wraps the three possible surfaces (effort-level picker, thinking
 * toggle, "unknown / unsupported" notice) into a single component
 * the `RouterControlsBar` renders. The parent does not have to know
 * which sub-component is in play — it just passes the resolved
 * capability, the current effort level / thinking mode, and the
 * change handlers.
 */
export const ReasoningControls: FC<{
  capability: ReasoningCapability | null;
  /** Provider-native reasoning-effort value (e.g. "low", "xhigh"). */
  reasoningLevel: string;
  onReasoningChange: (level: string) => void;
  thinkingMode: ThinkingMode;
  onThinkingModeChange: (mode: ThinkingMode) => void;
}> = ({ capability, reasoningLevel, onReasoningChange, thinkingMode, onThinkingModeChange }) => {
  // No capability at all (e.g. registry not yet loaded).
  if (!capability) {
    return (
      <div className="rounded-md border border-border/50 bg-muted/20 px-2 py-1 text-xs text-muted-foreground">
        Loading reasoning controls…
      </div>
    );
  }
  if (capability.kind === "effort_levels") {
    if (capability.control === "unknown" || capability.options.length === 0) {
      return (
        <div
          className="rounded-md border border-border/50 bg-muted/20 px-2 py-1 text-xs text-muted-foreground"
          title="This model's reasoning-effort surface is not documented. The runtime will not send a fake reasoningEffort value."
        >
          Reasoning capability unknown
        </div>
      );
    }
    return (
      <ReasoningLevelSelect
        value={reasoningLevel}
        options={capability.options}
        onChange={onReasoningChange}
      />
    );
  }
  if (capability.kind === "thinking_budget") {
    return (
      <ThinkingModeSelect
        value={thinkingMode}
        onChange={onThinkingModeChange}
        capability={capability}
      />
    );
  }
  if (capability.kind === "none") {
    return (
      <div
        className="rounded-md border border-border/50 bg-muted/20 px-2 py-1 text-xs text-muted-foreground"
        title={capability.reason ?? "Reasoning controls are not supported for this provider."}
      >
        Reasoning controls are not supported for this provider.
      </div>
    );
  }
  // kind: "unknown"
  return (
    <div
      className="rounded-md border border-border/50 bg-muted/20 px-2 py-1 text-xs text-muted-foreground"
      title={
        capability.reason ??
        "No metadata is available for this model id — the runtime will not send fake reasoning params."
      }
    >
      Reasoning capability unknown
    </div>
  );
};

/**
 * On/off toggle for the Router A/B mode itself. When off, the chat route
 * still runs Side A as today but never invokes the router or Side B.
 */
export const RouterAbToggle: FC<{
  on: boolean;
  onToggle: (next: boolean) => void;
}> = ({ on, onToggle }) => {
  return (
    <Button
      type="button"
      data-testid="router-ab-toggle"
      data-on={on ? "true" : "false"}
      variant="ghost"
      size="xs"
      onClick={() => onToggle(!on)}
      aria-pressed={on}
      aria-label={`Router A/B mode (currently ${on ? "on" : "off"})`}
      className={cn(
        "h-7 gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition-colors",
        on
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300"
          : "border-border/60 bg-muted/20 text-muted-foreground hover:bg-muted/40 hover:text-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full transition-colors",
          on ? "bg-emerald-500" : "bg-muted-foreground/50",
        )}
      />
      <span>A/B {on ? "on" : "off"}</span>
    </Button>
  );
};

/**
 * On/off toggle for the "Recommend model" feature in the chat composer.
 *
 * When OFF, the user picks the chat model directly with the manual
 * selector and sends messages without any recommender call.
 *
 * When ON, every send goes through a recommendation round-trip first:
 * the configured recommender model picks an answer model, the user
 * sees the recommendation + explanation in a banner, and they either
 * Accept (switch model + send) or Decline (send with the manual
 * model). The configured recommender model id lives in Settings →
 * Router → Normal-chat recommender model (separate from the A/B
 * recommender and the manual selector).
 *
 * Visually the toggle matches `RouterAbToggle` so the two sit
 * naturally side-by-side in the composer toolbar.
 */
export const RecommenderToggle: FC<{
  on: boolean;
  onToggle: (next: boolean) => void;
  disabled?: boolean;
  disabledReason?: string;
}> = ({ on, onToggle, disabled = false, disabledReason }) => {
  return (
    <Button
      type="button"
      data-testid="recommender-toggle"
      data-on={on ? "true" : "false"}
      variant="ghost"
      size="xs"
      onClick={() => onToggle(!on)}
      disabled={disabled}
      aria-pressed={on}
      title={disabled ? disabledReason : undefined}
      aria-label={`Recommend model toggle (currently ${on ? "on" : "off"})`}
      className={cn(
        "h-7 gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition-colors",
        on
          ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15"
          : "border-border/60 bg-muted/20 text-muted-foreground hover:bg-muted/40 hover:text-foreground",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <Sparkles
        className={cn("size-3 transition-colors", on ? "text-primary" : "text-muted-foreground/70")}
      />
      <span>Recommend {on ? "on" : "off"}</span>
    </Button>
  );
};

/**
 * Inline control that pairs the `Recommend on/off` toggle with the
 * `Recommender model` picker. Used by the chat composer so the user
 * can both turn the recommender on AND choose which model it runs
 * without leaving the page.
 *
 * Layout (matches the chat UI mockup):
 *   - Left column:  `Recommend on/off` pill (in its own bordered well).
 *   - Right column: two rows, separated by a subtle horizontal divider:
 *       1. Primary recommender engine (model + reasoning).
 *       2. Fallback engine (one) — always rendered, with a
 *          `No fallback` option that round-trips to `null`.
 *
 * Both children remain independently controlled by the parent so the
 * recommender on/off state (sessionStorage) and the configured model
 * id (server-side Postgres row) can live in different stores. The
 * primary + fallback model ids and reasoning levels read/write the
 * canonical Tab B fields
 * (`normalChatRecommenderModelId`/`…ReasoningLevel` and
 * `…FallbackModelId`/`…FallbackReasoningLevel`) via the existing
 * `/api/router/settings` PATCH path — see `app/assistant.tsx` for the
 * handlers. We deliberately do NOT mirror them in any chat-only
 * localStorage; the Settings page must always show the same value as
 * the chat composer.
 */
export const RecommenderControl: FC<{
  enabled: boolean;
  onToggle: (next: boolean) => void;
  toggleDisabled?: boolean;
  toggleDisabledReason?: string;
  modelId: string | null;
  modelOptions: ReadonlyArray<RecommenderModelOption>;
  onModelChange: (modelId: string) => void;
  modelLoading?: boolean;
  modelSaving?: boolean;
  /** Provider-native reasoning-effort value (e.g. "low", "xhigh"). */
  reasoningLevel?: string;
  onReasoningChange?: (level: string) => void;
  fallbackModelId?: string | null;
  fallbackReasoningLevel?: string | null;
  onFallbackModelChange?: (modelId: string | null) => void;
  onFallbackReasoningChange?: (level: string | null) => void;
}> = ({
  enabled,
  onToggle,
  toggleDisabled = false,
  toggleDisabledReason,
  modelId,
  modelOptions,
  onModelChange,
  modelLoading = false,
  modelSaving = false,
  reasoningLevel = "low",
  onReasoningChange,
  fallbackModelId = null,
  fallbackReasoningLevel = null,
  onFallbackModelChange,
  onFallbackReasoningChange,
}) => {
  const selectedEngine = modelOptions.find((o) => o.modelId === modelId) ?? null;
  const selectedFallback = modelOptions.find((o) => o.modelId === fallbackModelId) ?? null;

  return (
    <div
      className="flex w-full flex-col gap-3 rounded-xl border border-border/60 bg-muted/5 px-3 py-3 shadow-sm sm:flex-row sm:items-stretch sm:gap-3"
      data-testid="recommender-control"
    >
      {/* Left column — Recommend on/off well. The well has its own
          subtle border so the toggle reads as a single grouped control
          even though the right-hand rows are stacked vertically. */}
      <div
        className="flex shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/60 px-3 py-2 sm:py-0"
        data-testid="recommender-toggle-well"
      >
        <RecommenderToggle
          on={enabled}
          onToggle={onToggle}
          disabled={toggleDisabled}
          disabledReason={toggleDisabledReason}
        />
      </div>

      <div className="min-w-0 flex-1">
        {/* Primary recommender engine row. */}
        <div
          className="grid items-center gap-2 lg:grid-cols-[minmax(14rem,1fr)_minmax(20rem,1.35fr)_9rem]"
          data-testid="chat-recommender-engine-controls"
        >
          <div className="min-w-0 text-xs leading-tight text-muted-foreground">
            <div className="font-semibold text-foreground">Recommender engine</div>
            <div>This model recommends which model to use. It is not the chat model itself.</div>
          </div>
          <RecommenderModelSelector
            compact
            options={modelOptions}
            value={modelId ?? ""}
            onChange={onModelChange}
            disabled={modelLoading || modelSaving}
            testId="chat-recommender-model"
            id="chat-recommender-model"
          />
          {onReasoningChange ? (
            <ProviderNativeSelect
              testId="chat-recommender-reasoning"
              ariaLabel="Recommender engine reasoning / thinking"
              value={reasoningLevel}
              selectedOption={selectedEngine}
              disabled={modelLoading || modelSaving}
              onChange={(next) => onReasoningChange(next ?? "")}
            />
          ) : null}
        </div>

        {/* Fallback engine row, separated from the primary row by a
            subtle horizontal divider. The fallback is always rendered
            (with a "No fallback" option) so the user has a single
            grouped control surface, not three unrelated rows. */}
        {onFallbackModelChange ? (
          <div
            className="mt-3 grid items-center gap-2 border-t border-border/50 pt-3 lg:grid-cols-[minmax(14rem,1fr)_minmax(20rem,1.35fr)_9rem]"
            data-testid="chat-recommender-fallback-controls"
          >
            <div className="min-w-0 text-xs leading-tight text-muted-foreground">
              <div className="font-semibold text-foreground">Fallback engine (one)</div>
              <div>Used only if the primary recommender engine fails.</div>
            </div>
            <select
              data-testid="chat-recommender-fallback-model"
              value={fallbackModelId ?? ""}
              onChange={(e) => onFallbackModelChange(e.target.value === "" ? null : e.target.value)}
              disabled={modelLoading || modelSaving}
              aria-label="Fallback recommender engine model"
              className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-9 min-w-0 rounded-md border px-2 text-xs shadow-xs outline-none focus-visible:ring-[3px] disabled:opacity-60"
            >
              <option value="">No fallback</option>
              {modelOptions.map((option) => (
                <option key={option.modelId} value={option.modelId}>
                  {option.displayLabel} · {option.providerLabel}
                </option>
              ))}
            </select>
            {onFallbackReasoningChange ? (
              <ProviderNativeSelect
                testId="chat-recommender-fallback-reasoning"
                ariaLabel="Fallback recommender engine reasoning / thinking"
                value={fallbackReasoningLevel ?? ""}
                selectedOption={selectedFallback}
                disabled={modelLoading || modelSaving || !fallbackModelId}
                onChange={(next) => onFallbackReasoningChange(next)}
              />
            ) : null}
          </div>
        ) : null}
        {modelSaving ? (
          <span
            className="mt-2 block text-[10px] text-muted-foreground"
            data-testid="chat-recommender-model-saving"
            aria-live="polite"
          >
            saving…
          </span>
        ) : null}
      </div>
    </div>
  );
};

const ProviderNativeSelect: FC<{
  testId: string;
  ariaLabel: string;
  value: string;
  selectedOption: RecommenderModelOption | null;
  disabled: boolean;
  onChange: (value: string | null) => void;
}> = ({ testId, ariaLabel, value, selectedOption, disabled, onChange }) => {
  const choices = selectedOption
    ? getProviderNativeOptionChoices(selectedOption.reasoningCapability)
    : [{ value: "", label: "Pick a model" }];
  return (
    <select
      data-testid={testId}
      value={value}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      disabled={disabled || choices.length === 0}
      aria-label={ariaLabel}
      title="Provider-native value — forwarded verbatim to the recommender provider."
      className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-7 rounded-md border px-2 text-xs shadow-xs outline-none focus-visible:ring-[3px] disabled:opacity-60"
    >
      {choices.map((choice, idx) => (
        <option key={`${choice.value}-${idx}`} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </select>
  );
};

// Suppress unused-import warnings for components re-exported from this file.
// KbdHint / Button are kept available for the panel below.
void KbdHint;
