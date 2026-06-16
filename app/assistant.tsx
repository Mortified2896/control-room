"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useChatRuntime, AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { Sidebar } from "@/components/assistant-ui/sidebar";
import { Thread } from "@/components/assistant-ui/thread";
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

export const Assistant = () => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const [threads, setThreads] = useState(INITIAL_THREADS);
  const [activeThreadId, setActiveThreadId] = useState("1");
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

      <div className="h-full flex-1 min-w-0 overflow-hidden">
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
  );
};
