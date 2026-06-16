"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MessageSquare, Plus } from "lucide-react";
import type { FC } from "react";

type Thread = {
  id: string;
  title: string;
};

type SidebarProps = {
  threads: Thread[];
  activeThreadId: string;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
};

export const Sidebar: FC<SidebarProps> = ({
  threads,
  activeThreadId,
  onSelectThread,
  onNewThread,
}) => {
  return (
    <div className="flex h-full w-64 flex-col border-r border-border bg-background">
      <div className="border-border border-b px-3 py-2">
        <Button
          variant="ghost"
          className="w-full justify-start gap-2 text-sm"
          onClick={onNewThread}
        >
          <Plus className="size-4" />
          New chat
        </Button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-2">
        {threads.map((thread) => (
          <button
            key={thread.id}
            type="button"
            onClick={() => onSelectThread(thread.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
              activeThreadId === thread.id
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
            )}
          >
            <MessageSquare className="size-4 shrink-0" />
            <span className="truncate">{thread.title}</span>
          </button>
        ))}
      </nav>
    </div>
  );
};
