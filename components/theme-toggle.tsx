"use client";

import { useEffect, useState, type FC } from "react";
import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Theme toggle (light / dark).
 *
 * The app's colors are driven by the `.dark` class on the `<html>`
 * element (see `app/globals.css`). This component flips that class
 * and persists the choice in localStorage under
 * `control_room.theme` so the choice survives reloads. The same
 * localStorage key is read by the inline boot script in
 * `app/layout.tsx` so the theme is applied before React hydrates
 * (avoids a flash of the wrong theme on hard reload).
 *
 * The toggle renders two visual states: a sun icon when the current
 * theme is dark (clicking switches to light) and a moon icon when
 * the current theme is light (clicking switches to dark). The
 * button has `aria-pressed` so screen readers announce the active
 * theme.
 *
 * Initial render is hydration-sensitive: the component reads the
 * current `<html>` class on mount so it never flashes the wrong
 * icon. We deliberately avoid rendering until mounted (same
 * pattern the rest of the assistant shell uses) to keep SSR and
 * client markup identical and avoid hydration mismatches.
 */

export type ThemeMode = "light" | "dark";

const STORAGE_KEY = "control_room.theme";

function readCurrentTheme(): ThemeMode {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function readPersistedTheme(): ThemeMode | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "light" || raw === "dark" ? raw : null;
  } catch {
    return null;
  }
}

function applyTheme(theme: ThemeMode) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // localStorage may be unavailable (private mode, quota, etc.).
    // The class flip still works for this session.
  }
}

export const ThemeToggle: FC<{
  className?: string;
}> = ({ className }) => {
  const [mounted, setMounted] = useState(false);
  // On mount, read the actual current theme (could be persisted
  // from a previous session OR system preference if no persisted
  // value yet). Defaults to light if the boot script didn't set
  // anything.
  const [theme, setTheme] = useState<ThemeMode>("light");

  useEffect(() => {
    const persisted = readPersistedTheme();
    if (persisted) {
      setTheme(persisted);
      // Re-apply in case the boot script didn't run (e.g. when
      // SSR delivered a page without it).
      applyTheme(persisted);
    } else {
      setTheme(readCurrentTheme());
    }
    setMounted(true);
  }, []);

  const next: ThemeMode = theme === "dark" ? "light" : "dark";
  const label =
    theme === "dark"
      ? "Switch to light theme (currently dark)"
      : "Switch to dark theme (currently light)";

  // Render a stable, non-flashing button during SSR + first paint
  // by always showing the moon (i.e. "click to go dark"). The icon
  // swaps to the sun once mounted and the real theme is known.
  const showSun = mounted && theme === "dark";

  return (
    <Button
      type="button"
      data-testid="theme-toggle"
      data-theme={mounted ? theme : "ssr"}
      onClick={() => {
        const target = next;
        applyTheme(target);
        setTheme(target);
      }}
      variant="ghost"
      size="xs"
      aria-label={label}
      aria-pressed={theme === "dark"}
      title={label}
      className={cn(
        "h-7 w-7 rounded-full border border-border/60 bg-muted/20 p-0 text-muted-foreground",
        "hover:border-border hover:bg-muted/40 hover:text-foreground",
        className,
      )}
    >
      {showSun ? (
        <Sun className="size-3.5" aria-hidden />
      ) : (
        <Moon className="size-3.5" aria-hidden />
      )}
    </Button>
  );
};
