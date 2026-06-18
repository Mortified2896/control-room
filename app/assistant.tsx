"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useChatRuntime, AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { Sidebar } from "@/components/assistant-ui/sidebar";
import { Thread } from "@/components/assistant-ui/thread";
import { KbdHint } from "@/components/kbd-hint";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FC } from "react";

import {
  SHORTCUT_TARGETS,
  type ShortcutTarget,
  eventMatchesCombo,
  isTypingTarget,
} from "@/lib/shortcuts";

/**
 * Click or focus the element that owns a given shortcut target.
 *
 * - For New chat / User settings / Select model: the element is a button,
 *   so we call .click() which fires its onClick handler.
 * - For Search chats: the element is the <input>, so we focus it.
 * - For Help: the element is a button, .click() opens the dialog.
 * - For Focus composer: the element is the composer <textarea>, so we
 *   focus it.
 */
function triggerTarget(target: ShortcutTarget) {
  if (typeof document === "undefined") return;
  const el = document.querySelector<HTMLElement>(
    `[data-shortcut-target="${target}"]`,
  );
  if (!el) return;
  if (
    target === SHORTCUT_TARGETS.searchChats ||
    target === SHORTCUT_TARGETS.focusComposer
  ) {
    el.focus();
    if (el instanceof HTMLInputElement) el.select();
  } else {
    el.click();
  }
}

type ModelOption = {
  providerId: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  enabled: boolean;
  reason?: string;
};

type ModelsResponse = {
  models: ModelOption[];
  defaultModelId: string | null;
};

const INITIAL_THREADS = [
  { id: "1", title: "Control Room setup" },
  { id: "2", title: "Learn Chinese workflow" },
  { id: "3", title: "Hermes server task" },
  { id: "4", title: "Finance article draft" },
];

const ChatPane: FC<{ modelId: string | null }> = ({ modelId }) => {
  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: "/api/chat",
        body: { modelId },
      }),
    [modelId],
  );

  const runtime = useChatRuntime({
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    transport,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  );
};

const ModelSelector: FC<{
  models: ModelOption[];
  selectedModelId: string | null;
  onModelChange: (modelId: string) => void;
  loading: boolean;
}> = ({ models, selectedModelId, onModelChange, loading }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selected = models.find((m) => m.modelId === selectedModelId);
  const triggerLabel = selected
    ? selected.modelLabel
    : loading
      ? "Loading models…"
      : "Select model";

  return (
    <div
      ref={ref}
      className="relative flex items-center border-b border-border/60 bg-background px-4 py-2"
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        data-shortcut-target={SHORTCUT_TARGETS.selectModel}
        aria-label={`Select model (currently ${triggerLabel}; press M)`}
        className="aui-model-selector-trigger relative inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/20 py-1 pl-2.5 pr-10 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:bg-muted/40 hover:text-foreground"
        disabled={loading}
      >
        <span className="size-1.5 rounded-full bg-emerald-500/80" aria-hidden />
        {triggerLabel}
        <ChevronDown className="size-3 opacity-70" />
        <KbdHint
          combo="m"
          className="aui-model-selector-shortcut pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 bg-background/60"
        />
      </button>

      {open && (
        <div className="absolute left-4 top-full z-50 mt-1 w-64 max-h-80 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md">
          {models.length === 0 && !loading && (
            <div className="px-3 py-2 text-xs text-muted-foreground">No models available</div>
          )}
          {(() => {
            // Assign ⌘1..⌘9 to the first 9 *enabled* models in display order.
            // This way the "press ⌘3 to switch to the third enabled model"
            // behavior is consistent with what the user sees in the list.
            const enabledIndexById = new Map<string, number>();
            let enabledCounter = 0;
            for (const m of models) {
              if (!m.enabled) continue;
              enabledCounter += 1;
              if (enabledCounter <= 9) {
                enabledIndexById.set(m.modelId, enabledCounter);
              }
            }
            return models.map((m) => {
              const isSelected = m.modelId === selectedModelId;
              const disabled = !m.enabled;
              const shortcutIndex = enabledIndexById.get(m.modelId);
              return (
                <button
                  key={`${m.providerId}:${m.modelId}`}
                  type="button"
                  disabled={disabled}
                  title={disabled ? (m.reason ?? "Not available") : undefined}
                  onClick={() => {
                    if (disabled) return;
                    onModelChange(m.modelId);
                    setOpen(false);
                  }}
                  className={
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors " +
                    (disabled
                      ? "cursor-not-allowed text-muted-foreground/60"
                      : isSelected
                        ? "bg-accent text-accent-foreground"
                        : "text-popover-foreground hover:bg-accent/50 hover:text-accent-foreground")
                  }
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{m.modelLabel}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {m.providerLabel}
                      {disabled && m.reason ? ` — ${m.reason}` : ""}
                    </div>
                  </div>
                  {shortcutIndex !== undefined && (
                    <KbdHint
                      combo={`${shortcutIndex}`}
                      className="aui-model-dropdown-shortcut bg-background/40"
                    />
                  )}
                </button>
              );
            });
          })()}
        </div>
      )}
    </div>
  );
};

export const Assistant = () => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const [threads, setThreads] = useState(INITIAL_THREADS);
  const [activeThreadId, setActiveThreadId] = useState("1");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const newChatCounter = useRef(0);

  useEffect(() => {
    if (!mounted) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/models", { cache: "no-store" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data: ModelsResponse = await res.json();
        if (cancelled) return;
        setModels(data.models);
        setSelectedModelId((prev) =>
          prev && data.models.some((m) => m.modelId === prev && m.enabled)
            ? prev
            : data.defaultModelId,
        );
        setModelsError(null);
      } catch (err) {
        if (cancelled) return;
        setModelsError(err instanceof Error ? err.message : "Failed to load models");
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mounted]);

  const handleNewThread = useCallback(() => {
    newChatCounter.current += 1;
    const newThread = {
      id: `local-${Date.now()}-${newChatCounter.current}`,
      title: `New chat ${newChatCounter.current}`,
    };
    setThreads((prev) => [newThread, ...prev]);
    setActiveThreadId(newThread.id);
  }, []);

  const handleSelectThread = useCallback((id: string) => {
    setActiveThreadId(id);
  }, []);

  // Centralized keyboard-shortcut handler. See lib/shortcuts.ts for the
  // full registry. The typing guard (isTypingTarget) is enforced here for
  // every shortcut marked requiresIdle in SHORTCUT_ENTRIES, so we never
  // hijack a key the user is typing into an input / textarea /
  // contenteditable. We also bail on e.repeat and on modifier keys for
  // single-key shortcuts, so the user can still use browser shortcuts
  // like Cmd+N (Firefox new window) or Cmd+Shift+; without our handler
  // firing first.
  useEffect(() => {
    if (!mounted) return;
    const handler = (e: KeyboardEvent) => {
      if (e.repeat) return;
      // Help: Cmd+/ or Ctrl+/. Fires anywhere, even while typing.
      if (eventMatchesCombo(e, "mod+/")) {
        e.preventDefault();
        const help = document.querySelector<HTMLElement>(
          `[data-shortcut-target="${SHORTCUT_TARGETS.help}"]`,
        );
        help?.click();
        return;
      }
      const idle = !isTypingTarget(e.target);
      // Idle-only single-key shortcuts.
      if (idle) {
        // Bare key, no modifiers — let the browser's own bindings run if
        // the user is holding one (e.g. Cmd+N new window). The single
        // letters below only fire on the unmodified key.
        const noMods = !e.metaKey && !e.ctrlKey && !e.altKey;
        if (noMods) {
          const k = e.key.toLowerCase();
          // 1..9 select the Nth enabled model. The dropdown uses the
          // same "first-N-enabled" rule for its badges, so the chip "1"
          // always lines up with the model this handler picks.
          if (k >= "1" && k <= "9") {
            const idx = Number(k) - 1;
            const enabled = models.filter((m) => m.enabled);
            const target = enabled[idx];
            if (target) {
              e.preventDefault();
              setSelectedModelId(target.modelId);
              return;
            }
          }
          let target: ShortcutTarget | null = null;
          if (k === "n") target = SHORTCUT_TARGETS.newChat;
          else if (k === "k") target = SHORTCUT_TARGETS.searchChats;
          else if (k === "m") target = SHORTCUT_TARGETS.selectModel;
          else if (k === "c") target = SHORTCUT_TARGETS.focusComposer;
          else if (k === ",") target = SHORTCUT_TARGETS.userSettings;
          if (target) {
            e.preventDefault();
            triggerTarget(target);
            return;
          }
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [mounted, models]);

  if (!mounted) return <div className="h-dvh" />;

  return (
    <div className="flex h-dvh">
      <Sidebar
        threads={threads}
        activeThreadId={activeThreadId}
        onSelectThread={handleSelectThread}
        onNewThread={handleNewThread}
      />

      <div className="flex h-full flex-1 min-w-0 flex-col overflow-hidden">
        <ModelSelector
          models={models}
          selectedModelId={selectedModelId}
          onModelChange={setSelectedModelId}
          loading={modelsLoading}
        />

        {modelsError && (
          <div className="border-b border-border bg-destructive/10 px-4 py-2 text-xs text-destructive">
            Failed to load models: {modelsError}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-hidden">
          {threads.map((thread) => (
            <div key={thread.id} className={thread.id === activeThreadId ? "h-full" : "hidden"}>
              <ChatPane modelId={selectedModelId} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
