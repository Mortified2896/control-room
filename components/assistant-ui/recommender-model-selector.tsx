"use client";

import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { useMediaQuery } from "@/components/layout/use-media-query";
import { cn } from "@/lib/utils";
import type { ReasoningCapability } from "@/lib/providers/capability";

/**
 * One selectable recommender-model entry. This is the same shape
 * `components/settings/router-settings-page.tsx` already builds in
 * `normalChatRecommenderModelOptions` (OpenAI API rows + Codex catalog
 * rows + MiniMax rows), so the settings page can pass its memoized
 * array directly.
 */
export type RecommenderModelOption = {
  modelId: string;
  displayLabel: string;
  providerLabel: string;
  providerId: string;
  reasoningCapability: ReasoningCapability;
};

type Props = {
  /** Available recommender-model options, in display order. */
  options: ReadonlyArray<RecommenderModelOption>;
  /** Currently-selected model id (controlled). */
  value: string;
  /** Called when the user picks a different model. */
  onChange: (modelId: string) => void;
  /** When true, render the destructive focus ring (form errors). */
  invalid?: boolean;
  /**
   * `data-testid` for the underlying native `<select>`. The Settings
   * page passes `router-settings-normal-chat-recommender-model` here so
   * the existing Playwright contract (`expect(selector).toHaveValue(...)`)
   * keeps working without changes.
   */
  testId?: string;
  /**
   * Optional id of helper text that should be associated with the
   * trigger via `aria-describedby`.
   */
  ariaDescribedBy?: string;
  /** Render the trigger as disabled. */
  disabled?: boolean;
  /** `id` for the underlying native `<select>` so a parent
   * `<label htmlFor>` keeps its association. */
  id?: string;
  /**
   * Compact mode — drops the in-trigger "RECOMMENDER" badge and the
   * panel header so the picker can sit inline in the chat composer
   * next to the existing `Recommend on/off` toggle (which already
   * labels the surrounding context). Width also flips from `w-full`
   * to inline so it matches the reasoning picker beside it.
   */
  compact?: boolean;
  /** Optional id of the panel header (compact mode only). */
  panelHeaderId?: string;
};

const triggerBase =
  "aui-recommender-model-selector-trigger relative inline-flex min-h-10 w-full items-center gap-1.5 rounded-md border border-border/50 bg-muted/20 py-1 pl-2.5 pr-8 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:bg-muted/40 hover:text-foreground sm:min-h-0 sm:pr-10";

const triggerDisabled = "disabled:cursor-not-allowed disabled:opacity-60";

const optionBase =
  "flex min-h-10 w-full items-start gap-2 px-3 py-2 text-left text-xs transition-colors sm:min-h-0 sm:py-1.5";

const optionIdle = "text-popover-foreground hover:bg-accent/50 hover:text-accent-foreground";

const optionSelected = "bg-accent text-accent-foreground";

/**
 * Model selector for the **normal-chat recommender** only.
 *
 * Styled to match the main chat `ModelSelector` pill (rounded trigger,
 * bordered dropdown panel, Radix-Dialog bottom-sheet on phones) so the
 * settings page reads as the same component family as the chat composer,
 * but with explicit visual cues — a `Sparkles` icon, a "RECOMMENDER"
 * badge on the trigger, and a panel header — that make it impossible to
 * confuse with the picker that decides which model answers chat messages.
 *
 * Form integration: the visible trigger is a `<button>` driving custom
 * dropdown UI. Underneath it lives a visually-hidden native `<select>`
 * that mirrors the current `value` and carries the `data-testid` so:
 *   - `screen readers` announce the choice via the native semantics,
 *   - the existing Playwright contract
 *     (`getByTestId("router-settings-normal-chat-recommender-model").toHaveValue(...)`)
 *     keeps passing,
 *   - and any non-JS form submission would still send the right value.
 */
export const RecommenderModelSelector: FC<Props> = ({
  options,
  value,
  onChange,
  invalid = false,
  testId,
  ariaDescribedBy,
  disabled = false,
  id,
  compact = false,
  panelHeaderId,
}) => {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const isPhone = useMediaQuery("(max-width: 639px)");

  // Close on outside click on desktop. On phones the Radix Dialog owns
  // the open state and we close via its overlay.
  useEffect(() => {
    if (isPhone) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isPhone]);

  const selected = options.find((m) => m.modelId === value);

  // If the persisted `value` isn't in the option list (e.g. the
  // configured provider was disabled since last save), fall back to
  // showing the raw id rather than a blank trigger. While the parent
  // is still hydrating we show "Loading…" so the user never sees a
  // momentary "Select recommender model" that flips to a model name.
  const triggerLabel = selected
    ? selected.displayLabel
    : value
      ? value
      : options.length === 0
        ? "Loading…"
        : "Select recommender model";
  const triggerSubLabel = selected?.providerLabel ?? null;

  const renderOption = (m: RecommenderModelOption) => {
    const isSelected = m.modelId === value;
    return (
      <button
        key={m.modelId}
        type="button"
        role="option"
        aria-selected={isSelected}
        onClick={() => {
          if (disabled) return;
          onChange(m.modelId);
          setOpen(false);
        }}
        disabled={disabled}
        className={cn(optionBase, isSelected ? optionSelected : optionIdle)}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{m.displayLabel}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1 truncate text-[10px] text-muted-foreground">
            <span>{m.providerLabel}</span>
            <span aria-hidden>·</span>
            <span className="font-mono">{m.modelId}</span>
          </div>
        </div>
        {isSelected ? (
          <span className="shrink-0 self-center text-[10px] font-medium uppercase tracking-wide text-primary">
            Selected
          </span>
        ) : null}
      </button>
    );
  };

  const renderOptions = useMemo(
    () => () => options.map(renderOption),
    // We intentionally re-build the option list when the inputs change.
    // The function reference is only used inside the JSX below, which
    // already re-renders on every render anyway, so including
    // `options`/`value`/`onChange` here keeps ESLint happy without
    // changing behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options, value, onChange, disabled],
  );

  return (
    <div ref={wrapperRef} className={cn("relative", compact ? "inline-flex" : "w-full")}>
      {/*
        Visually-hidden native <select> that mirrors `value`. It carries
        the `data-testid` so the existing Playwright test
        (`expect(getByTestId("router-settings-normal-chat-recommender-model"))
          .toHaveValue("codex:gpt-5.4-mini")`) continues to work. We
        always inject a synthetic option for the current value so the
        select never has an orphan value.
      */}
      <label className="sr-only">
        Recommender model
        <select
          id={id}
          data-testid={testId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          tabIndex={-1}
        >
          {options.map((m) => (
            <option key={m.modelId} value={m.modelId}>
              {m.displayLabel} · {m.providerLabel} ({m.modelId})
            </option>
          ))}
          {!options.some((m) => m.modelId === value) && value ? (
            <option value={value}>{value} (current)</option>
          ) : null}
        </select>
      </label>

      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Recommender model selector (currently ${triggerLabel}${
          triggerSubLabel ? `, ${triggerSubLabel}` : ""
        })`}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        className={cn(
          triggerBase,
          triggerDisabled,
          invalid && "border-destructive/60 focus-visible:ring-destructive/40",
        )}
      >
        <Sparkles className="size-3 shrink-0 text-primary/70" aria-hidden />
        {compact ? null : (
          <span
            className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary"
            aria-hidden
            title="This picker only chooses the model used by the recommender — it does not change the chat model."
          >
            Recommender
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-left text-foreground">{triggerLabel}</span>
        {triggerSubLabel ? (
          <span className="hidden shrink-0 rounded bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
            {triggerSubLabel}
          </span>
        ) : null}
        <ChevronDown className="size-3 shrink-0 opacity-70" />
      </button>

      {open && !isPhone && (
        <div
          role="listbox"
          aria-label="Recommender model options"
          className={cn(
            "absolute left-0 top-full z-50 mt-1 max-h-80 min-w-[20rem] overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md",
            compact ? "w-72" : "w-full",
          )}
        >
          {compact ? null : (
            <div className="border-b border-border/60 bg-muted/10 px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
              <Sparkles
                className="mr-1 inline-block size-3 align-[-1px] text-primary/70"
                aria-hidden
              />
              Recommender model — picks the model that runs the recommender only
            </div>
          )}
          {options.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              No models available for the recommender
            </div>
          ) : (
            renderOptions()
          )}
        </div>
      )}

      <DialogPrimitive.Root open={open && isPhone} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <DialogPrimitive.Content className="fixed inset-x-0 bottom-0 z-50 max-h-[70dvh] overflow-hidden rounded-t-2xl border border-border bg-popover shadow-lg outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom">
            <div className="safe-bottom flex max-h-[70dvh] flex-col">
              <div className="border-b border-border/60 px-4 py-3">
                <DialogPrimitive.Title
                  id={panelHeaderId}
                  className="flex items-center gap-2 text-sm font-semibold text-popover-foreground"
                >
                  <Sparkles className="size-4 text-primary/80" aria-hidden />
                  Recommender model
                </DialogPrimitive.Title>
                <DialogPrimitive.Description className="mt-1 text-xs text-muted-foreground">
                  Choose which model the &ldquo;Recommend model&rdquo; toggle uses. This does{" "}
                  <strong>not</strong> change the model that answers your chat messages — only the
                  small model that picks a good answer model for you.
                </DialogPrimitive.Description>
              </div>
              <div
                className="overflow-y-auto py-1"
                role="listbox"
                aria-label="Recommender model options"
              >
                {options.length === 0 ? (
                  <div className="px-4 py-3 text-xs text-muted-foreground">
                    No models available for the recommender
                  </div>
                ) : (
                  options.map(renderOption)
                )}
              </div>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
};
