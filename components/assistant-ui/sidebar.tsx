"use client";

import { Button } from "@/components/ui/button";
import { KbdHint } from "@/components/kbd-hint";
import { ShortcutsHelp } from "@/components/shortcuts-help";
import { cn } from "@/lib/utils";
import { Folder, FolderGit2, MessageSquare, Plus, Search, Trash2, X } from "lucide-react";
import Link from "next/link";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useState, type FC, type FormEvent } from "react";

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

type BrowseFolder = {
  name: string;
  localPath: string;
  isGitRepo: boolean;
  isAlreadyProject: boolean;
  gitRemoteUrl: string | null;
  gitBranch: string | null;
};

type SidebarProps = {
  threads: Thread[];
  projects: Project[];
  activeProjectId: string | null;
  onSelectProject: (id: string | null) => void;
  onOpenProject: (localPath: string) => Promise<boolean | void> | boolean | void;
  activeThreadId: string;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onDeleteAllThreads: () => void;
  deleteAllDisabled?: boolean;
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
  onDeleteAllThreads,
  deleteAllDisabled = false,
  onClose,
}) => {
  const [query, setQuery] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [folders, setFolders] = useState<BrowseFolder[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [foldersError, setFoldersError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [openingPath, setOpeningPath] = useState<string | null>(null);

  useEffect(() => {
    if (!folderPickerOpen) return;
    let cancelled = false;
    setFoldersLoading(true);
    setFoldersError(null);
    (async () => {
      try {
        const res = await fetch("/api/projects/browse", { cache: "no-store" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data: { folders: BrowseFolder[] } = await res.json();
        if (!cancelled) setFolders(data.folders);
      } catch (err) {
        if (!cancelled)
          setFoldersError(err instanceof Error ? err.message : "Failed to load folders");
      } finally {
        if (!cancelled) setFoldersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [folderPickerOpen]);

  async function openProjectPath(localPath: string) {
    setOpeningPath(localPath);
    const opened = await onOpenProject(localPath);
    setOpeningPath(null);
    if (opened !== false) {
      setFolderPath("");
      setFolderPickerOpen(false);
      onClose?.();
    }
  }

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
          Workspace projects
        </h2>
        <p className="mb-2 px-1 text-[11px] text-muted-foreground/60">Local repos on Hermes VM</p>
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
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2 w-full justify-center text-xs"
          onClick={() => setFolderPickerOpen(true)}
        >
          <Folder className="size-3.5" />
          Open folder…
        </Button>
      </div>

      <DialogPrimitive.Root open={folderPickerOpen} onOpenChange={setFolderPickerOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/50 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-[61] max-h-[85dvh] w-[min(92vw,720px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-border bg-background shadow-xl outline-none">
            <div className="flex items-start justify-between gap-4 border-b border-border/50 px-5 py-4">
              <div>
                <DialogPrimitive.Title className="text-base font-semibold text-foreground">
                  Open project folder
                </DialogPrimitive.Title>
                <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">
                  Choose a local Git repo under <code>/home/hermes/workspace/repos</code>.
                </DialogPrimitive.Description>
              </div>
              <DialogPrimitive.Close asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close folder picker"
                >
                  <X className="size-4" />
                </Button>
              </DialogPrimitive.Close>
            </div>

            <div className="max-h-[55dvh] overflow-y-auto p-3">
              {foldersLoading && (
                <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                  Loading folders…
                </div>
              )}
              {foldersError && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {foldersError}
                </div>
              )}
              {!foldersLoading && !foldersError && folders.length === 0 && (
                <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                  No folders found.
                </div>
              )}
              <div className="space-y-1">
                {folders.map((folder) => (
                  <button
                    key={folder.localPath}
                    type="button"
                    disabled={!folder.isGitRepo || openingPath === folder.localPath}
                    title={folder.isGitRepo ? folder.localPath : "Not a Git repo"}
                    onClick={() => void openProjectPath(folder.localPath)}
                    className="flex w-full items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors enabled:hover:border-border enabled:hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    {folder.isGitRepo ? (
                      <FolderGit2 className="size-5 shrink-0 text-primary" />
                    ) : (
                      <Folder className="size-5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {folder.name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {folder.localPath}
                      </span>
                      {(folder.gitBranch || folder.gitRemoteUrl) && (
                        <span className="block truncate text-[11px] text-muted-foreground/80">
                          {[folder.gitBranch, folder.gitRemoteUrl].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1 text-[10px]">
                      {folder.isAlreadyProject && (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">
                          Already opened
                        </span>
                      )}
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 font-medium",
                          folder.isGitRepo
                            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {folder.isGitRepo ? "Git repo" : "Not a Git repo"}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="border-t border-border/50 px-5 py-3">
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                onClick={() => setManualOpen((v) => !v)}
              >
                Enter path manually
              </button>
              {manualOpen && (
                <form
                  className="mt-2 flex gap-2"
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault();
                    if (!folderPath.trim()) return;
                    void openProjectPath(folderPath.trim());
                  }}
                >
                  <input
                    type="text"
                    value={folderPath}
                    onChange={(e) => setFolderPath(e.target.value)}
                    placeholder="/home/hermes/workspace/repos/..."
                    aria-label="Open project folder manually"
                    className="min-w-0 flex-1 rounded-md border border-border/50 bg-muted/30 px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
                  />
                  <Button
                    type="submit"
                    variant="outline"
                    size="sm"
                    disabled={!folderPath.trim() || openingPath != null}
                  >
                    Open
                  </Button>
                </form>
              )}
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {/* Chat actions */}
      <div className="space-y-2 px-3 pt-3">
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
        <Button
          type="button"
          variant="ghost"
          disabled={deleteAllDisabled || threads.length === 0}
          className="w-full justify-center gap-1.5 rounded-lg py-2 text-xs font-medium text-destructive/80 hover:bg-destructive/10 hover:text-destructive disabled:text-muted-foreground/40"
          onClick={() => {
            onDeleteAllThreads();
            onClose?.();
          }}
        >
          <Trash2 className="size-3.5" />
          Delete all chats
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
