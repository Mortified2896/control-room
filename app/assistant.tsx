"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useChatRuntime, AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { Sidebar } from "@/components/assistant-ui/sidebar";
import { Thread } from "@/components/assistant-ui/thread";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FC } from "react";

const INITIAL_THREADS = [
  { id: "1", title: "Control Room setup" },
  { id: "2", title: "Learn Chinese workflow" },
  { id: "3", title: "Hermes server task" },
  { id: "4", title: "Finance article draft" },
];

const ChatPane: FC = () => {
  const runtime = useChatRuntime({
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    transport: new AssistantChatTransport({
      api: "/api/chat",
    }),
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  );
};

const ModelSelector: FC<{
  selectedModel: string;
  onModelChange: (model: string) => void;
}> = ({ selectedModel, onModelChange }) => {
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

  const models = ["ChatGPT", "MiniMax"];

  return (
    <div
      ref={ref}
      className="relative flex items-center border-b border-border px-4 py-2"
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        {selectedModel}
        <ChevronDown className="size-3" />
      </button>

      {open && (
        <div className="absolute left-4 top-full z-50 mt-1 w-32 rounded-md border border-border bg-popover py-1 shadow-md">
          {models.map((model) => (
            <button
              key={model}
              type="button"
              onClick={() => {
                onModelChange(model);
                setOpen(false);
              }}
              className={
                "flex w-full items-center px-3 py-1.5 text-left text-xs transition-colors " +
                (selectedModel === model
                  ? "bg-accent text-accent-foreground"
                  : "text-popover-foreground hover:bg-accent/50 hover:text-accent-foreground")
              }
            >
              {model}
            </button>
          ))}
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
  const [selectedModel, setSelectedModel] = useState("ChatGPT");
  const newChatCounter = useRef(0);

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
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
        />

        <div className="min-h-0 flex-1 overflow-hidden">
          {threads.map((thread) => (
            <div
              key={thread.id}
              className={thread.id === activeThreadId ? "h-full" : "hidden"}
            >
              <ChatPane />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
