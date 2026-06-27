"use client";

import { Button } from "@/components/ui/button";
import { KbdHint } from "@/components/kbd-hint";
import { ShortcutsHelp } from "@/components/shortcuts-help";
import { cn } from "@/lib/utils";
import { FolderGit2, MessageSquare, Plus, Search, X } from "lucide-react";
import Link from "next/link";
import { useState, type FC, type FormEvent } from "react";

import { SHORTCUT_TARGETS } from "@/lib/shortcuts";

type Thread = {
  id: string;
  title: string;
};

type Project = {
  id: string;
  name: string;
  localPath: string;
};

type SidebarProps = {
  threads: Thread[];
  projects: Project[];
  activeProjectId: string | null;
  onSelectProject: (id: string | null) => void;
  onOpenProject: (localPath: string) => void;
  activeThreadId: string;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onClose?: () => void;
};

export const Sidebar: FC<SidebarProps> = ({
  threads,
  projects,
  activeProjectId,
  onSelectProject,
  onOpenProject,
  activeThreadId,
  onSelectThread,
  onNewThread,
  onClose,
}) => {
  const [query, setQuery] = useState("");
  const [folderPath, setFolderPath] = useState("");

  const filtered = query.trim()
    ? threads.filter((t) => t.title.toLowerCase().includes(query.trim().toLowerCase()))
    : threads;

  return (
    <div className="flex h-full w-64 flex-col border-r border-border/60 bg-muted/20">
      {/* Header */}
      <div className="flex items-start justify-between border-b border-border/40 px-4 py-3.5">
        <div>
          <h1 className="text-sm font-semibold text-foreground">Control Room</h1>
          <p className="text-[11px] text-muted-foreground/70">Personal AI workbench</p>
        </div>
        {onClose && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="-mr-1 md:hidden"
            aria-label="Close sidebar"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        )}
      </div>

      {/* Project picker */}
      <div className="border-b border-border/40 px-3 py-3">
        <h2 className="mb-1.5 px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
          Project context
        </h2>
        <div className="space-y-1">
          <button
            type="button"
            onClick={() => onSelectProject(null)}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors",
              activeProjectId == null
                ? "bg-primary/10 font-medium text-foreground ring-1 ring-primary/20"
                : "text-muted-foreground/80 hover:bg-accent/40 hover:text-foreground",
            )}
          >
            <MessageSquare className="size-3.5" /> General chat
          </button>
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              title={project.localPath}
              onClick={() => onSelectProject(project.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors",
                activeProjectId === project.id
                  ? "bg-primary/10 font-medium text-foreground ring-1 ring-primary/20"
                  : "text-muted-foreground/80 hover:bg-accent/40 hover:text-foreground",
              )}
            >
              <FolderGit2 className="size-3.5 shrink-0" />
              <span className="truncate">{project.name}</span>
            </button>
          ))}
        </div>
        <form
          className="mt-2 flex gap-1"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!folderPath.trim()) return;
            onOpenProject(folderPath.trim());
            setFolderPath("");
          }}
        >
          <input
            type="text"
            value={folderPath}
            onChange={(e) => setFolderPath(e.target.value)}
            placeholder="/home/hermes/workspace/repos/..."
            aria-label="Open project folder"
            className="min-w-0 flex-1 rounded-md border border-border/50 bg-muted/30 px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
          />
          <Button type="submit" variant="outline" size="sm" className="px-2 text-[11px]">
            Open
          </Button>
        </form>
      </div>

      {/* New chat */}
      <div className="px-3 pt-3">
        <Button
          variant="outline"
          data-shortcut-target={SHORTCUT_TARGETS.newChat}
          className="aui-sidebar-new-chat relative w-full justify-center gap-1.5 rounded-lg border-border/60 bg-muted/30 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          onClick={() => {
            onNewThread();
            onClose?.();
          }}
        >
          <Plus className="size-3.5" />
          New Chat
          <KbdHint
            combo="n"
            className="aui-sidebar-new-chat-shortcut absolute right-2 top-1/2 -translate-y-1/2 bg-background/60"
          />
        </Button>
      </div>

      {/* Search */}
      <form className="px-3 pt-3" onSubmit={(e: FormEvent) => e.preventDefault()} role="search">
        <label className="relative block">
          <Search className="aui-sidebar-search-icon pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/50" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            data-shortcut-target={SHORTCUT_TARGETS.searchChats}
            aria-label="Search chats (press K)"
            className="aui-sidebar-search w-full rounded-lg border border-border/50 bg-muted/30 py-1.5 pl-8 pr-10 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-muted-foreground/40 focus:outline-none"
          />
          <KbdHint
            combo="k"
            className="aui-sidebar-search-shortcut absolute right-2 top-1/2 -translate-y-1/2 bg-background/60"
          />
        </label>
      </form>

      {/* Chats */}
      <nav className="flex-1 overflow-y-auto px-3 pt-3 pb-2">
        <h2 className="aui-sidebar-section-label mb-1.5 px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
          Recent chats
        </h2>
        <div className="space-y-0.5">
          {filtered.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground/60">
              No chats match “{query.trim()}”
            </div>
          )}
          {filtered.map((thread) => (
            <button
              key={thread.id}
              type="button"
              onClick={() => {
                onSelectThread(thread.id);
                onClose?.();
              }}
              className={cn(
                "aui-sidebar-thread flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs transition-colors",
                activeThreadId === thread.id
                  ? "bg-primary/10 font-medium text-foreground"
                  : "text-muted-foreground/80 hover:bg-accent/40 hover:text-foreground",
              )}
            >
              <MessageSquare className="size-3.5 shrink-0" />
              <span className="truncate">{thread.title}</span>
            </button>
          ))}
        </div>
      </nav>

      {/* Footer: keyboard shortcuts help + user settings */}
      <div className="border-t border-border/40 px-3 py-2.5">
        <div className="space-y-0.5">
          <div className="hidden sm:block">
            <ShortcutsHelp />
          </div>
          <Link
            href="/settings"
            data-shortcut-target={SHORTCUT_TARGETS.userSettings}
            className="aui-sidebar-settings flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground/60 transition-colors hover:bg-muted/30 hover:text-muted-foreground"
            aria-label="Open settings (press comma)"
            onClick={() => onClose?.()}
          >
            <div className="flex size-6 items-center justify-center rounded-full bg-muted/40 text-[10px] font-medium">
              S
            </div>
            <span>Settings</span>
            <KbdHint combo="," className="aui-sidebar-settings-shortcut ml-auto bg-background/60" />
          </Link>
        </div>
      </div>
    </div>
  );
};
