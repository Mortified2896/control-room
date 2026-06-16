"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useChatRuntime, AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { Sidebar } from "@/components/assistant-ui/sidebar";
import { Thread } from "@/components/assistant-ui/thread";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FC } from "react";

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
    <div ref={ref} className="relative flex items-center border-b border-border px-4 py-2">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        disabled={loading}
      >
        {triggerLabel}
        <ChevronDown className="size-3" />
      </button>

      {open && (
        <div className="absolute left-4 top-full z-50 mt-1 w-56 max-h-80 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md">
          {models.length === 0 && !loading && (
            <div className="px-3 py-2 text-xs text-muted-foreground">No models available</div>
          )}
          {models.map((m) => {
            const isSelected = m.modelId === selectedModelId;
            const disabled = !m.enabled;
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
                  "flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left text-xs transition-colors " +
                  (disabled
                    ? "cursor-not-allowed text-muted-foreground/60"
                    : isSelected
                      ? "bg-accent text-accent-foreground"
                      : "text-popover-foreground hover:bg-accent/50 hover:text-accent-foreground")
                }
              >
                <span className="font-medium">{m.modelLabel}</span>
                <span className="text-[10px] text-muted-foreground">
                  {m.providerLabel}
                  {disabled && m.reason ? ` — ${m.reason}` : ""}
                </span>
              </button>
            );
          })}
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
