"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type FC } from "react";

import { Dialog as DialogPrimitive } from "radix-ui";
import { useMediaQuery } from "@/components/layout/use-media-query";
import { KbdHint } from "@/components/kbd-hint";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ReasoningLevel } from "@/lib/providers/types";

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
  value: ReasoningLevel;
  options: ReadonlyArray<ReasoningLevel>;
  onChange: (level: ReasoningLevel) => void;
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

  const optionButtons = options.map((level) => {
    const isSelected = level === value;
    return (
      <button
        key={level}
        type="button"
        data-reasoning-level={level}
        onClick={() => {
          onChange(level);
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
          <div className="truncate font-medium capitalize">{level} reasoning</div>
          <div className="truncate text-[10px] text-muted-foreground">{labelFor(level)}</div>
        </div>
      </button>
    );
  });

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
        <span className="truncate capitalize">{value} reasoning</span>
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

function labelFor(level: ReasoningLevel): string {
  switch (level) {
    case "low":
      return "Faster, cheaper answers.";
    case "medium":
      return "Balanced speed and depth.";
    case "high":
      return "Slowest, deepest reasoning.";
  }
}

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

// Suppress unused-import warnings for components re-exported from this file.
// KbdHint / Button are kept available for the panel below.
void KbdHint;
