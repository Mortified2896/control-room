"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { lastAssistantMessageIsCompleteWithToolCalls, type UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ChevronDown,
  Columns3,
  ListFilter,
  Loader2,
  MessageSquare,
  Pin,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import { Thread } from "@/components/assistant-ui/thread";
import { Button } from "@/components/ui/button";
import { messageRowsToUIMessages } from "@/lib/assistant-ui/thread-messages";
import type { CreateRoomCandidate, CreateRoomEpisode, WorkflowStep } from "@/lib/repo/create-room";
import { cn } from "@/lib/utils";

const STAGES: { key: WorkflowStep; label: string }[] = [
  { key: "idea_vocab", label: "Idea + Vocab" },
  { key: "title", label: "Title" },
  { key: "thumbnail", label: "Thumbnail" },
  { key: "outline", label: "Outline" },
  { key: "script", label: "Script" },
  { key: "review", label: "Review" },
  { key: "ready", label: "Ready" },
  { key: "published", label: "Published" },
];
const stageLabel = (step: WorkflowStep) => STAGES.find((s) => s.key === step)?.label ?? step;

type ModelOption = { modelId: string; modelLabel: string; enabled: boolean };
type MessageRow = {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system";
  content: string | null;
  parts: unknown;
  modelId: string | null;
  createdAt: string;
  rating?: "up" | "down" | null;
};

function EpisodeChat({
  episode,
  messages,
  modelId,
  onFinish,
  workflowContent,
}: {
  episode: CreateRoomEpisode;
  messages: UIMessage[];
  modelId: string | null;
  onFinish: () => void;
  workflowContent: ReactNode;
}) {
  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: "/api/chat",
        body: {
          modelId,
          threadId: episode.threadId,
          system: `You are the Create Room production assistant for ${episode.episodeCode}. The episode is at the ${stageLabel(episode.workflowStep)} step. Working title: ${episode.workingTitle ?? "Untitled"}. Selected idea: ${episode.selectedIdea ?? "Not selected"}. Learner level: ${episode.targetLearnerLevel ?? "Beginner"}. Selected title: ${episode.selectedTitle ?? "Not selected"}. Help the user make the next production decision.`,
        },
      }),
    [episode.threadId, modelId],
  );
  const runtime = useChatRuntime({
    id: episode.threadId,
    messages,
    onFinish,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    transport,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread threadId={episode.threadId} workflowContent={workflowContent} showWelcome={false} />
    </AssistantRuntimeProvider>
  );
}

function WorkspaceHeader({
  models,
  modelId,
  setModelId,
}: {
  models: ModelOption[];
  modelId: string | null;
  setModelId: (id: string) => void;
}) {
  return (
    <header className="flex h-[68px] shrink-0 items-center justify-between border-b border-border/60 bg-background px-4">
      <div className="flex items-center gap-3">
        <div className="grid size-9 place-items-center rounded-xl border border-border text-[10px] font-bold">
          LCB
        </div>
        <div className="h-8 w-px bg-border" />
        <button className="flex min-w-56 items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[.06] px-3 py-2 text-left">
          <Sparkles className="size-4 text-amber-400" />
          <span className="flex-1">
            <span className="block text-sm font-semibold text-amber-200">Create Room</span>
            <span className="block text-[10px] text-muted-foreground">
              Content production studio
            </span>
          </span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="hidden sm:inline">Model</span>
        <select
          value={modelId ?? ""}
          onChange={(e) => setModelId(e.target.value)}
          className="rounded-md border border-border bg-muted/30 px-2 py-1.5 outline-none"
        >
          {models
            .filter((m) => m.enabled)
            .map((m) => (
              <option key={m.modelId} value={m.modelId}>
                {m.modelLabel}
              </option>
            ))}
        </select>
      </label>
    </header>
  );
}

function EpisodeSidebar({
  episodes,
  selectedId,
  onSelect,
  onNew,
  view,
  setView,
  busy,
}: {
  episodes: CreateRoomEpisode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  view: "chat" | "kanban";
  setView: (v: "chat" | "kanban") => void;
  busy: boolean;
}) {
  const [query, setQuery] = useState("");
  const filtered = episodes.filter((e) =>
    `${e.episodeCode} ${e.workingTitle ?? ""} ${stageLabel(e.workflowStep)}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <aside className="flex w-[268px] shrink-0 flex-col border-r border-border/60 bg-muted/[.08]">
      <div className="grid grid-cols-2 gap-1 border-b border-border/60 p-3">
        <Button
          size="sm"
          variant={view === "chat" ? "secondary" : "ghost"}
          onClick={() => setView("chat")}
        >
          <MessageSquare />
          Chats
        </Button>
        <Button
          size="sm"
          variant={view === "kanban" ? "secondary" : "ghost"}
          onClick={() => setView("kanban")}
        >
          <Columns3 />
          Kanban
        </Button>
      </div>
      <div className="flex gap-2 p-3">
        <label className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search episodes…"
            className="w-full rounded-md border border-border bg-background py-2 pl-8 pr-2 text-xs outline-none focus:border-ring"
          />
        </label>
        <Button size="icon-sm" variant="outline" aria-label="Filter episodes">
          <ListFilter />
        </Button>
      </div>
      <div className="px-4 pb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        Episode chats
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {filtered.map((e) => (
          <button
            key={e.id}
            onClick={() => onSelect(e.id)}
            className={cn(
              "mb-1 w-full rounded-lg border px-3 py-2.5 text-left transition-colors",
              selectedId === e.id
                ? "border-amber-500/30 bg-amber-500/[.07]"
                : "border-transparent hover:bg-muted/40",
            )}
          >
            <div className="text-xs font-semibold">{e.episodeCode}</div>
            <div className="mt-1 truncate text-[11px] text-muted-foreground">
              {e.workingTitle || "Untitled episode"}
            </div>
            <div className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="size-1.5 rounded-full bg-amber-400" />
              {stageLabel(e.workflowStep)}
            </div>
          </button>
        ))}
      </div>
      <div className="p-3">
        <Button
          variant="outline"
          className="w-full border-amber-500/25 text-amber-300"
          onClick={onNew}
          disabled={busy}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}New episode chat
        </Button>
      </div>
    </aside>
  );
}

function WorkflowTimeline({
  episode,
  candidates,
  onGenerate,
  onSelect,
  busy,
}: {
  episode: CreateRoomEpisode;
  candidates: CreateRoomCandidate[];
  onGenerate: () => void;
  onSelect: (id: string) => void;
  busy: boolean;
}) {
  const titles =
    episode.workflowStep === "title"
      ? candidates.filter((c) => c.type === "title" && c.status !== "archived")
      : [];
  return (
    <div className="flex flex-col gap-4 px-2">
      {episode.workflowStep === "title" && !episode.selectedTitle && (
        <div className="flex gap-3">
          <div className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-muted/30">
            <Sparkles className="size-4 text-amber-400" />
          </div>
          <div className="max-w-2xl rounded-2xl rounded-tl-md border border-border bg-muted/20 px-4 py-3">
            <p className="text-sm leading-6">
              We are at the Title step for {episode.episodeCode}. Want me to generate 5 title ideas
              based on the episode foundation?
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={onGenerate} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
                Generate 5 titles
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  document
                    .querySelector<HTMLTextAreaElement>("[data-slot='aui_composer-shell'] textarea")
                    ?.focus()
                }
              >
                Edit prompt first
              </Button>
              <Button size="sm" variant="ghost" disabled>
                Skip
              </Button>
            </div>
          </div>
        </div>
      )}
      {titles.length > 0 && (
        <div className="ml-11">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Title candidates
            </div>
            {episode.workflowStep === "title" && (
              <Button size="xs" variant="ghost" onClick={onGenerate} disabled={busy}>
                Generate 5 more
              </Button>
            )}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {titles.map((c) => {
              const title = String(c.payload.title ?? "Untitled");
              const selected = c.status === "selected";
              return (
                <article
                  key={c.id}
                  className={cn(
                    "rounded-xl border p-4",
                    selected ? "border-amber-500/40 bg-amber-500/[.06]" : "border-border bg-card",
                  )}
                >
                  <div className="flex items-center justify-between text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <span>{String(c.payload.style ?? "Title")}</span>
                    {selected && <Pin className="size-3 text-amber-400" />}
                  </div>
                  <h3 className="mt-2 text-sm font-semibold">{title}</h3>
                  <p className="mt-1 min-h-10 text-xs leading-5 text-muted-foreground">
                    {String(c.payload.rationale ?? "")}
                  </p>
                  <div className="mt-3 flex gap-1.5">
                    <Button
                      size="xs"
                      variant={selected ? "secondary" : "outline"}
                      onClick={() => onSelect(c.id)}
                      disabled={selected || busy}
                    >
                      {selected ? "Selected" : "Select"}
                    </Button>
                    <Button size="xs" variant="ghost" disabled>
                      Revise
                    </Button>
                    <Button size="xs" variant="ghost" disabled>
                      More like this
                    </Button>
                    <Button size="xs" variant="ghost" disabled>
                      Reject
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function EpisodeState({ episode }: { episode: CreateRoomEpisode }) {
  const rows = [
    ["Episode Foundation", episode.targetLearnerLevel || "Not selected yet"],
    ["Selected Title", episode.selectedTitle || "Not selected yet"],
    ["Thumbnail Concept", episode.selectedThumbnailConcept || "Not selected yet"],
    ["Outline", "Not selected yet"],
    ["Script", "Not selected yet"],
    ["Publishing", "Not selected yet"],
  ];
  return (
    <aside className="hidden w-[286px] shrink-0 border-l border-border/60 bg-muted/[.08] xl:block">
      <div className="border-b border-border/60 p-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">Episode state</h2>
            <p className="text-[10px] text-muted-foreground">Pinned production decisions</p>
          </div>
          <Pin className="size-4 text-muted-foreground" />
        </div>
      </div>
      <div className="flex flex-col gap-2 p-3">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className={cn(
              "rounded-lg border p-3",
              value !== "Not selected yet"
                ? "border-amber-500/25 bg-amber-500/[.04]"
                : "border-border",
            )}
          >
            <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              {label}
            </div>
            <div
              className={cn(
                "mt-1.5 text-xs",
                value === "Not selected yet" && "italic text-muted-foreground",
              )}
            >
              {value}
            </div>
          </div>
        ))}
        <div className="mt-3 border-t border-border pt-4">
          <div className="mb-3 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
            Workflow
          </div>
          {STAGES.map((s, i) => (
            <div key={s.key} className="relative flex items-center gap-2.5 pb-3 text-[11px]">
              <span
                className={cn(
                  "relative z-10 size-2.5 rounded-full border bg-background",
                  s.key === episode.workflowStep
                    ? "border-amber-400 bg-amber-400"
                    : "border-muted-foreground/50",
                )}
              />
              {i < STAGES.length - 1 && (
                <span className="absolute left-[4px] top-2 h-full w-px bg-border" />
              )}
              <span
                className={
                  s.key === episode.workflowStep ? "text-amber-300" : "text-muted-foreground"
                }
              >
                {s.label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

function Kanban({
  episodes,
  onSelect,
}: {
  episodes: CreateRoomEpisode[];
  onSelect: (id: string) => void;
}) {
  return (
    <main className="min-w-0 flex-1 overflow-auto p-5">
      <h1 className="text-lg font-semibold">Episode pipeline</h1>
      <p className="mt-1 text-xs text-muted-foreground">
        Select a card to open its persistent episode chat.
      </p>
      <div className="mt-5 grid min-w-[1400px] grid-cols-8 gap-3">
        {STAGES.map((stage) => (
          <section key={stage.key}>
            <div className="mb-2 flex justify-between px-1 text-[11px] font-semibold text-muted-foreground">
              <span>{stage.label}</span>
              <span>{episodes.filter((e) => e.workflowStep === stage.key).length}</span>
            </div>
            <div className="min-h-[65vh] rounded-xl border border-border/60 bg-muted/[.08] p-2">
              {episodes
                .filter((e) => e.workflowStep === stage.key)
                .map((e) => (
                  <button
                    key={e.id}
                    onClick={() => onSelect(e.id)}
                    className="mb-2 w-full rounded-lg border border-border bg-card p-3 text-left hover:border-amber-500/30"
                  >
                    <div className="text-[10px] font-semibold text-amber-300">{e.episodeCode}</div>
                    <div className="mt-2 text-xs font-medium leading-5">
                      {e.workingTitle || "Untitled episode"}
                    </div>
                    <div className="mt-3 text-[9px] text-muted-foreground">
                      Updated {new Date(e.updatedAt).toLocaleDateString()}
                    </div>
                  </button>
                ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}

export function CreateRoom() {
  const [episodes, setEpisodes] = useState<CreateRoomEpisode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CreateRoomCandidate[]>([]);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "kanban">("chat");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const episode = episodes.find((e) => e.id === selectedId) ?? null;
  const loadEpisodes = useCallback(async () => {
    const res = await fetch("/api/create-room/episodes", { cache: "no-store" });
    if (!res.ok) throw new Error("Could not load episodes");
    const data = await res.json();
    setEpisodes(data.episodes);
    setSelectedId((prev) =>
      prev && data.episodes.some((e: CreateRoomEpisode) => e.id === prev)
        ? prev
        : (data.episodes[0]?.id ?? null),
    );
  }, []);
  useEffect(() => {
    void loadEpisodes().catch((e) => setError(e.message));
    void fetch("/api/models", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        setModels(data.models);
        setModelId(data.defaultModelId);
      });
  }, [loadEpisodes]);
  useEffect(() => {
    if (!episode) {
      setCandidates([]);
      setMessages([]);
      return;
    }
    let cancelled = false;
    Promise.all([
      fetch(`/api/create-room/episodes/${episode.id}/candidates`, { cache: "no-store" }).then((r) =>
        r.json(),
      ),
      fetch(`/api/threads/${episode.threadId}/messages`, { cache: "no-store" }).then((r) =>
        r.json(),
      ),
    ])
      .then(([c, m]) => {
        if (cancelled) return;
        setCandidates(c.candidates ?? []);
        setMessages(messageRowsToUIMessages((m.messages ?? []) as MessageRow[]));
      })
      .catch(() => {
        if (!cancelled) setError("Could not load episode details");
      });
    return () => {
      cancelled = true;
    };
  }, [episode?.id, episode?.threadId]);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/create-room/episodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
      if (!res.ok) throw new Error("Could not create episode. Is the migration applied?");
      const { episode: newEpisode } = await res.json();
      setEpisodes((prev) => [newEpisode, ...prev]);
      setSelectedId(newEpisode.id);
      setView("chat");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  };
  const generate = async () => {
    if (!episode) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/create-room/episodes/${episode.id}/title-candidates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? "Generation failed");
      setCandidates((prev) => [
        ...prev.filter((c) => c.type !== "title" || c.status === "selected"),
        ...data.candidates,
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setBusy(false);
    }
  };
  const select = async (candidateId: string) => {
    if (!episode) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/create-room/episodes/${episode.id}/select-candidate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId }),
      });
      if (!res.ok) throw new Error("Selection failed");
      const data = await res.json();
      setEpisodes((prev) => prev.map((e) => (e.id === data.episode.id ? data.episode : e)));
      setCandidates((prev) =>
        prev.map((c) =>
          c.type === "title" ? { ...c, status: c.id === candidateId ? "selected" : "archived" } : c,
        ),
      );
      const messagesRes = await fetch(`/api/threads/${data.episode.threadId}/messages`, {
        cache: "no-store",
      });
      if (messagesRes.ok) {
        const messageData = await messagesRes.json();
        setMessages(messageRowsToUIMessages((messageData.messages ?? []) as MessageRow[]));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Selection failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dark flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <WorkspaceHeader models={models} modelId={modelId} setModelId={setModelId} />
      {error && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <EpisodeSidebar
          episodes={episodes}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setView("chat");
          }}
          onNew={() => void create()}
          view={view}
          setView={setView}
          busy={busy}
        />
        {view === "kanban" ? (
          <Kanban
            episodes={episodes}
            onSelect={(id) => {
              setSelectedId(id);
              setView("chat");
            }}
          />
        ) : episode ? (
          <>
            <main className="flex min-w-0 flex-1 flex-col">
              <div className="flex h-14 shrink-0 items-center border-b border-border/60 px-5">
                <div>
                  <h1 className="text-sm font-semibold">
                    {episode.episodeCode} · {stageLabel(episode.workflowStep)}
                  </h1>
                  <p className="text-[10px] text-muted-foreground">
                    {episode.workingTitle || "Untitled episode"}
                  </p>
                </div>
              </div>
              <div className="min-h-0 flex-1">
                <EpisodeChat
                  key={`${episode.id}:${messages.length}`}
                  episode={episode}
                  messages={messages}
                  modelId={modelId}
                  onFinish={() => void loadEpisodes()}
                  workflowContent={
                    <WorkflowTimeline
                      episode={episode}
                      candidates={candidates}
                      onGenerate={() => void generate()}
                      onSelect={(id) => void select(id)}
                      busy={busy}
                    />
                  }
                />
              </div>
            </main>
            <EpisodeState episode={episode} />
          </>
        ) : (
          <div className="grid flex-1 place-items-center">
            <div className="text-center">
              <Sparkles className="mx-auto size-7 text-amber-400" />
              <h1 className="mt-3 text-lg font-semibold">Create your first episode</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Every episode gets its own persistent production chat.
              </p>
              <Button className="mt-4" onClick={() => void create()} disabled={busy}>
                <Plus />
                New episode chat
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
