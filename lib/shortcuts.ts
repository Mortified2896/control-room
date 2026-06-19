/**
 * Firefox-safe keyboard shortcut registry for Control Room.
 *
 * The shortcut map and which keys are reserved for single-key triggers were
 * chosen to avoid colliding with browser / Firefox defaults:
 *
 *   - N (new chat)            — free in every major browser
 *   - K (search chats)        — free in every major browser (NOT Cmd/Ctrl+K,
 *                               which Firefox uses for the address/search bar)
 *   - M (open model selector) — free in every major browser
 *   - C (focus composer)      — free in every major browser (NOT "/", which
 *                               Firefox uses for Quick Find)
 *   - , (open user settings)  — free as a single key (NOT Cmd/Ctrl+, which
 *                               would collide with Firefox preferences)
 *   - Mod+/ (show this help)  — single dedicated binding for the help dialog;
 *                               "mod" is Cmd on macOS, Ctrl elsewhere
 *
 *   - Enter / Shift+Enter in the composer are handled by the assistant-ui
 *     ComposerPrimitive out of the box (send / newline).
 *   - ArrowUp in an empty composer is handled by assistant-ui for "edit
 *     previous prompt" out of the box.
 *
 * The "Copy last code block" shortcut (Mod+Shift+;) is intentionally NOT
 * implemented in this pass; the existing per-block copy button is the
 * supported path. It is listed in the help dialog as "not yet wired" so
 * users are not misled.
 */
import { isMacOs } from "@/lib/platform";

export { isMacOs };

/** Stable identifiers for each shortcut. Used as the data-shortcut-target key. */
export const SHORTCUT_TARGETS = {
  newChat: "new-chat",
  searchChats: "search-chats",
  selectModel: "select-model",
  selectModelByIndex: "select-model-by-index",
  focusComposer: "focus-composer",
  userSettings: "user-settings",
  help: "help",
} as const;

export type ShortcutTarget = (typeof SHORTCUT_TARGETS)[keyof typeof SHORTCUT_TARGETS];

/**
 * Human-readable description for the help dialog. Kept in one place so the
 * Dialog component, the badge labels, and the help affordance all stay in sync.
 */
export type ShortcutEntry = {
  /** Stable id matching SHORTCUT_TARGETS where applicable; otherwise a free id. */
  id: string;
  /** What the shortcut does, in title case. */
  label: string;
  /** Plain-text keys (e.g. "n", "mod+/", "enter", "shift+enter", "arrowup"). */
  combo: string;
  /** Whether this shortcut should NOT fire while the user is typing. */
  requiresIdle: boolean;
  /**
   * Optional custom chip content for the help dialog. Use this when the
   * natural combo doesn't read well as a kbd chip (e.g. "1-9" would render
   * as three keycaps separated by a hyphen). When omitted, the help
   * dialog falls back to rendering a KbdHint from the `combo` field.
   */
  chipLabel?: string;
  /** Optional human note for shortcuts that aren't fully wired yet. */
  note?: string;
};

export const SHORTCUT_ENTRIES: ShortcutEntry[] = [
  {
    id: SHORTCUT_TARGETS.newChat,
    label: "New chat",
    combo: "n",
    requiresIdle: true,
  },
  {
    id: SHORTCUT_TARGETS.searchChats,
    label: "Search chats",
    combo: "k",
    requiresIdle: true,
  },
  {
    id: SHORTCUT_TARGETS.selectModel,
    label: "Select model",
    combo: "m",
    requiresIdle: true,
  },
  {
    id: SHORTCUT_TARGETS.selectModelByIndex,
    label: "Switch to Nth enabled model",
    combo: "1-9",
    chipLabel: "1 — 9",
    requiresIdle: true,
    note: "Press 1-9 while the model selector is open or closed.",
  },
  {
    id: SHORTCUT_TARGETS.focusComposer,
    label: "Focus composer",
    combo: "c",
    requiresIdle: true,
  },
  {
    id: SHORTCUT_TARGETS.userSettings,
    label: "User settings",
    combo: ",",
    requiresIdle: true,
  },
  {
    id: SHORTCUT_TARGETS.help,
    label: "Show keyboard shortcuts",
    combo: "mod+/",
    requiresIdle: false,
  },
  {
    id: "send-message",
    label: "Send message",
    combo: "enter",
    requiresIdle: false,
  },
  {
    id: "newline",
    label: "New line in composer",
    combo: "shift+enter",
    requiresIdle: false,
  },
  {
    id: "edit-previous",
    label: "Edit previous prompt",
    combo: "arrowup",
    requiresIdle: false,
    note: "Only when composer is focused and empty.",
  },
  {
    id: "copy-last-code",
    label: "Copy last code block",
    combo: "mod+shift+;",
    requiresIdle: true,
    note: "Not wired yet. Use the per-block copy button.",
  },
];

/**
 * True if the given DOM event target is something the user is actively typing
 * into. We intentionally treat <input>, <textarea>, and any [contenteditable]
 * element as "typing" — the shortcut is suppressed in that case.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * Parse a combo string like "mod+/" or "shift+enter" or "," into the parts the
 * KeyboardEvent API expects. Returns null if the combo can't be parsed.
 */
export function parseCombo(combo: string): {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
} | null {
  const parts = combo
    .toLowerCase()
    .split("+")
    .map((p) => p.trim());
  if (parts.length === 0 || !parts[parts.length - 1]) return null;

  let mod = false;
  let shift = false;
  let alt = false;
  let key = "";
  for (const part of parts) {
    if (part === "mod" || part === "cmd" || part === "meta") mod = true;
    else if (part === "ctrl" || part === "control") mod = true;
    else if (part === "shift") shift = true;
    else if (part === "alt" || part === "option") alt = true;
    else key = part;
  }
  if (!key) return null;
  return { key, mod, shift, alt };
}

/** True if the keyboard event matches the combo. */
export function eventMatchesCombo(e: KeyboardEvent, combo: string): boolean {
  const parsed = parseCombo(combo);
  if (!parsed) return false;
  // Treat Mac Cmd and Ctrl as the "mod" key interchangeably: the user said
  // "mod" on Mac and "Ctrl" on Windows/Linux, but if a Linux user presses
  // Cmd by accident (e.g. on a Mac keyboard plugged into a Linux box), we
  // should still respond.
  const modPressed = e.metaKey || e.ctrlKey;
  if (parsed.mod !== modPressed) return false;
  if (parsed.shift !== e.shiftKey) return false;
  if (parsed.alt !== e.altKey) return false;
  return e.key.toLowerCase() === parsed.key;
}

/** Resolve the first DOM element with a given data-shortcut-target attribute. */
export function findShortcutTarget(id: ShortcutTarget): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(`[data-shortcut-target="${id}"]`);
}

/** Resolve a shortcut's display string for a UI chip. */
export function formatComboForBadge(combo: string): string {
  const mac = isMacOs();
  return combo
    .split("+")
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "mod") return mac ? "⌘" : "Ctrl";
      if (lower === "ctrl") return "Ctrl";
      if (lower === "shift") return mac ? "⇧" : "Shift";
      if (lower === "alt" || lower === "option") return mac ? "⌥" : "Alt";
      if (lower === "enter" || lower === "return") return "↵";
      if (lower === "arrowup") return "↑";
      if (lower === "arrowdown") return "↓";
      if (lower === "arrowleft") return "←";
      if (lower === "arrowright") return "→";
      if (lower === "esc" || lower === "escape") return "Esc";
      if (lower === "tab") return "Tab";
      if (part.length === 1) return part.toUpperCase();
      return part;
    })
    .join(" ");
}
