"use client";

import { useEffect, useRef, useState, type FC } from "react";
import { KeyboardIcon } from "lucide-react";

import { KbdHint } from "@/components/kbd-hint";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SHORTCUT_ENTRIES, SHORTCUT_TARGETS, isMacOs } from "@/lib/shortcuts";

/**
 * Subtle "?" affordance for the keyboard shortcut help dialog.
 *
 * - Renders a small icon-only button with a `⌘/` (or `Ctrl+/`) chip on its
 *   right edge.
 * - Opens a Radix Dialog listing every shortcut in SHORTCUT_ENTRIES.
 * - Exposes itself as a shortcut target so the global keydown handler in
 *   `app/assistant.tsx` can open the dialog when the user presses `mod+/`,
 *   even when the button isn't focused.
 */
export const ShortcutsHelp: FC = () => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [mac, setMac] = useState<boolean | null>(null);

  useEffect(() => {
    setMac(isMacOs());
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-shortcut-target={SHORTCUT_TARGETS.help}
        aria-label="Show keyboard shortcuts"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="aui-shortcuts-help flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground/60 transition-colors hover:bg-muted/30 hover:text-muted-foreground"
      >
        <KeyboardIcon className="aui-shortcuts-help-icon size-3.5" />
        <span>Keyboard shortcuts</span>
        <KbdHint
          combo={mac === null ? "ctrl+/" : mac ? "mod+/" : "ctrl+/"}
          className="aui-shortcuts-help-shortcut ml-auto bg-background/60"
        />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>
              Shortcuts that fire anywhere in the app, except when you&apos;re typing in an input,
              textarea, or contenteditable field.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border/40">
                {SHORTCUT_ENTRIES.map((entry) => (
                  <tr key={entry.id} className="align-top">
                    <td className="py-2 pr-4 text-foreground">{entry.label}</td>
                    <td className="py-2 text-right">
                      {entry.chipLabel ? (
                        <span
                          aria-hidden="true"
                          data-slot="kbd-hint"
                          className="inline-flex shrink-0 select-none items-center gap-0.5 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground/80 shadow-[inset_0_-1px_0_rgb(0_0_0_/_0.04)]"
                        >
                          {entry.chipLabel}
                        </span>
                      ) : (
                        <KbdHint combo={entry.combo} className="bg-muted/40" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-4 text-xs text-muted-foreground/70">
              <KbdHint combo="mod" className="bg-muted/40 align-middle" /> is the Command key on
              macOS, Ctrl on Windows/Linux. The &quot;Copy last code block&quot; shortcut is
              reserved for a future release; use the copy button on each code block in the meantime.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};
