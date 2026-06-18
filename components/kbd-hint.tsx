import { cn } from "@/lib/utils";
import { isMacOs } from "@/lib/platform";
import { useEffect, useState, type HTMLAttributes } from "react";

type KbdHintProps = {
  /**
   * Comma- OR plus-separated key sequence, e.g. "mod,n", "mod+/", "shift+enter".
   * - "mod" resolves to ⌘ on macOS and Ctrl elsewhere.
   * - Other recognized aliases: cmd/meta, ctrl, alt/option, shift, enter/return,
   *   esc/escape, space/spacebar, tab, arrowup/down/left/right.
   * - Use "," or "+" to separate multiple keys in one chip.
   *   ("+" is preferred for readability; "," is kept for back-compat.)
   */
  combo: string;
  className?: string;
} & Omit<HTMLAttributes<HTMLSpanElement>, "children">;

function resolveKey(key: string, mac: boolean): string {
  const lower = key.toLowerCase();
  if (lower === "mod") return mac ? "⌘" : "Ctrl";
  if (lower === "cmd" || lower === "meta") return "⌘";
  if (lower === "ctrl" || lower === "control") return "Ctrl";
  if (lower === "alt" || lower === "option") return mac ? "⌥" : "Alt";
  if (lower === "shift") return mac ? "⇧" : "Shift";
  if (lower === "enter" || lower === "return") return "↵";
  if (lower === "esc" || lower === "escape") return "Esc";
  if (lower === "space" || lower === "spacebar") return "Space";
  if (lower === "tab") return "Tab";
  if (lower === "arrowup") return "↑";
  if (lower === "arrowdown") return "↓";
  if (lower === "arrowleft") return "←";
  if (lower === "arrowright") return "→";
  // Single character or symbol — keep as-is, but uppercase letters look better
  // in shortcut chips.
  if (key.length === 1) return key.toUpperCase();
  return key;
}

export function KbdHint({ combo, className, ...rest }: KbdHintProps) {
  // Start as "unknown" so server and first-paint HTML match (avoids
  // hydration mismatch warnings on macOS where "mod" would otherwise
  // resolve to different strings on server vs client).
  const [mac, setMac] = useState<boolean | null>(null);
  useEffect(() => {
    setMac(isMacOs());
  }, []);

  // Split on either "," or "+" so callers can write either "mod,n" or
  // "mod+n" / "mod+/" as feels natural.
  const keys = combo
    .split(/[,+]/)
    .map((k) => k.trim())
    .filter(Boolean);
  return (
    <span
      // Visual hint only — never focusable, never read by screen readers,
      // so it doesn't pollute tab order or accessible name of the
      // interactive element it sits next to.
      aria-hidden="true"
      data-slot="kbd-hint"
      className={cn(
        "inline-flex shrink-0 select-none items-center gap-0.5 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground/80 shadow-[inset_0_-1px_0_rgb(0_0_0_/_0.04)]",
        className,
      )}
      {...rest}
    >
      {keys.map((k, i) => (
        <kbd
          key={`${k}-${i}`}
          className="font-mono text-[10px] leading-none"
        >
          {mac === null ? resolveKey(k, false) : resolveKey(k, mac)}
        </kbd>
      ))}
    </span>
  );
}
