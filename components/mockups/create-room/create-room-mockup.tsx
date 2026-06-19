"use client";

import { useMemo, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Filter,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Pin,
  Plus,
  Search,
  Send,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { cn } from "@/lib/utils";

const stages = [
  "Idea + Vocab",
  "Title",
  "Thumbnail",
  "Outline",
  "Script",
  "Review",
  "Ready",
  "Published",
];
const episodes = [
  {
    code: "LCB-007",
    title: "Farm animal friends",
    stage: "Idea + Vocab",
    meta: "5 focus words",
    updated: "Updated today",
  },
  {
    code: "LCB-006",
    title: "Colors everywhere",
    stage: "Script",
    meta: "Draft v2",
    updated: "Updated today",
  },
  {
    code: "LCB-005",
    title: "My toy train",
    stage: "Review",
    meta: "Needs review",
    updated: "Yesterday",
  },
  { code: "LCB-004", title: "Big and small", stage: "Outline", meta: "6 scenes", updated: "Mon" },
  {
    code: "LCB-003",
    title: "In the park",
    stage: "Ready",
    meta: "Assets ready",
    updated: "Jun 12",
  },
  { code: "LCB-002", title: "I can jump", stage: "Published", meta: "Published", updated: "Jun 8" },
  {
    code: "LCB-001",
    title: "Hello, world!",
    stage: "Published",
    meta: "Published",
    updated: "May 29",
  },
];

function ActionButton({
  children,
  primary,
  onClick,
}: {
  children: React.ReactNode;
  primary?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-lg border px-3 py-2 text-[12px] font-medium transition hover:-translate-y-px",
        primary
          ? "border-amber-500/50 bg-amber-500/12 text-amber-300 hover:bg-amber-500/20"
          : "border-white/10 bg-white/[.025] text-zinc-300 hover:bg-white/[.06]",
      )}
    >
      {children}
    </button>
  );
}

function CandidateActions({ selected, onSelect }: { selected?: boolean; onSelect?: () => void }) {
  return (
    <div className="mt-4 flex flex-wrap gap-1.5 border-t border-white/[.07] pt-3">
      <ActionButton primary={selected} onClick={onSelect}>
        {selected ? (
          <>
            <Check className="mr-1 inline size-3" />
            Selected
          </>
        ) : (
          "Select"
        )}
      </ActionButton>
      <ActionButton>Revise</ActionButton>
      <ActionButton>More like this</ActionButton>
      <ActionButton>Reject</ActionButton>
    </div>
  );
}

function WorkspaceSwitcher() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex min-w-64 items-center gap-3 rounded-xl border border-amber-500/45 bg-amber-500/[.06] px-3.5 py-2 text-left"
      >
        <div className="grid size-8 place-items-center rounded-lg border border-amber-500/25 bg-amber-500/10 text-amber-300">
          <Sparkles className="size-4" />
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-amber-200">Create Room</div>
          <div className="text-[11px] text-zinc-500">Content production studio</div>
        </div>
        <ChevronDown className="size-4 text-zinc-500" />
      </button>
      {open && (
        <>
          <button
            aria-label="Close workspace menu"
            className="fixed inset-0 z-20 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 top-[calc(100%+8px)] z-30 w-72 rounded-xl border border-white/10 bg-[#171819] p-1.5 shadow-2xl">
            <button className="w-full rounded-lg px-3 py-2.5 text-left hover:bg-white/5">
              <div className="text-sm text-zinc-200">Control Room</div>
              <div className="text-[11px] text-zinc-500">Personal AI workbench</div>
            </button>
            <button className="w-full rounded-lg bg-amber-500/10 px-3 py-2.5 text-left">
              <div className="text-sm font-medium text-amber-200">Create Room</div>
              <div className="text-[11px] text-zinc-500">Content production studio</div>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function EpisodeSidebar({
  view,
  setView,
  selected,
  setSelected,
}: {
  view: string;
  setView: (v: "chat" | "kanban") => void;
  selected: string;
  setSelected: (v: string) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () =>
      episodes.filter((e) =>
        `${e.code} ${e.title} ${e.stage}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [query],
  );
  return (
    <aside className="flex min-h-0 w-[270px] shrink-0 flex-col border-r border-white/[.07] bg-[#111213]">
      <div className="p-3">
        <div className="grid grid-cols-2 rounded-lg bg-black/25 p-1">
          {[
            ["chat", "Chats"],
            ["kanban", "Kanban"],
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setView(id as "chat" | "kanban")}
              className={cn(
                "rounded-md py-2 text-xs font-medium",
                view === id
                  ? "bg-white/[.08] text-amber-300 shadow-sm"
                  : "text-zinc-500 hover:text-zinc-300",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex gap-2 px-3 pb-3">
        <label className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 size-3.5 text-zinc-600" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search episodes…"
            className="w-full rounded-lg border border-white/[.08] bg-black/20 py-2 pl-8 pr-2 text-xs outline-none placeholder:text-zinc-600 focus:border-amber-500/30"
          />
        </label>
        <button className="rounded-lg border border-white/[.08] px-2.5 text-zinc-500 hover:text-zinc-300">
          <Filter className="size-3.5" />
        </button>
      </div>
      <div className="px-4 pb-2 text-[10px] font-semibold uppercase tracking-[.14em] text-zinc-600">
        Episode chats
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2">
        {filtered.map((e) => (
          <button
            key={e.code}
            onClick={() => {
              setSelected(e.code);
              setView("chat");
            }}
            className={cn(
              "w-full rounded-lg border px-3 py-2.5 text-left transition",
              selected === e.code
                ? "border-amber-500/30 bg-amber-500/[.08]"
                : "border-transparent hover:bg-white/[.035]",
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-200">{e.code}</span>
              <MoreHorizontal className="size-3.5 text-zinc-700" />
            </div>
            <div className="mt-1 truncate text-[12px] text-zinc-400">{e.title}</div>
            <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-zinc-600">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  e.stage === "Published"
                    ? "bg-emerald-500"
                    : e.stage === "Ready"
                      ? "bg-sky-400"
                      : "bg-amber-400",
                )}
              />
              {e.stage}
            </div>
          </button>
        ))}
      </div>
      <div className="p-3">
        <button className="flex w-full items-center justify-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[.06] py-2.5 text-xs font-medium text-amber-300">
          <Plus className="size-3.5" />
          New episode chat
        </button>
      </div>
    </aside>
  );
}

function FeedbackBar() {
  const [vote, setVote] = useState<"up" | "down" | null>(null);
  return (
    <div className="flex gap-1 text-zinc-600">
      <button
        onClick={() => setVote("up")}
        className={cn("p-1.5 hover:text-zinc-300", vote === "up" && "text-amber-300")}
      >
        <ThumbsUp className="size-3.5" />
      </button>
      <button
        onClick={() => setVote("down")}
        className={cn("p-1.5 hover:text-zinc-300", vote === "down" && "text-amber-300")}
      >
        <ThumbsDown className="size-3.5" />
      </button>
      <button className="p-1.5 hover:text-zinc-300">
        <Copy className="size-3.5" />
      </button>
      <button className="p-1.5 hover:text-zinc-300">
        <MessageSquare className="size-3.5" />
      </button>
    </div>
  );
}

function ChatView({
  selectedIdea,
  setSelectedIdea,
}: {
  selectedIdea: number;
  setSelectedIdea: (n: number) => void;
}) {
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-[#0e0f10]">
      <div className="flex h-14 items-center justify-between border-b border-white/[.07] px-5">
        <div>
          <h1 className="text-sm font-semibold text-zinc-100">LCB-007 · Idea + Vocab</h1>
          <p className="text-[10px] text-zinc-600">Farm animal friends · Updated just now</p>
        </div>
        <button className="rounded-lg border border-white/[.07] px-3 py-1.5 text-[11px] text-zinc-500">
          •••
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 px-7 py-7">
          <section>
            <div className="flex gap-3">
              <div className="grid size-8 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[.05]">
                <Sparkles className="size-4 text-amber-300" />
              </div>
              <div>
                <p className="max-w-xl text-[13px] leading-6 text-zinc-300">
                  We are in <strong className="text-zinc-100">Idea + Vocab</strong>. I can generate
                  3 episode concepts using high-priority HSK1 words.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <ActionButton primary>Generate ideas</ActionButton>
                  <ActionButton>Pick vocab first</ActionButton>
                  <ActionButton>Edit constraints</ActionButton>
                </div>
              </div>
            </div>
          </section>
          <section
            className={cn(
              "ml-11 rounded-xl border bg-[#17191a] p-5",
              selectedIdea === 1
                ? "border-amber-500/45 shadow-[0_0_0_1px_rgba(245,158,11,.05)]"
                : "border-white/[.08]",
            )}
          >
            <div className="mb-4 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-[.12em] text-amber-300">
                Concept 01
              </span>
              {selectedIdea === 1 && (
                <span className="flex items-center gap-1 text-[10px] font-semibold text-amber-300">
                  <Pin className="size-3" />
                  Pinned to episode
                </span>
              )}
            </div>
            <dl className="grid grid-cols-[125px_1fr] gap-y-3 text-[12px]">
              <dt className="text-zinc-600">Episode premise</dt>
              <dd className="text-zinc-200">
                A curious baby meets five animals on a sunny farm and learns their names in Chinese.
              </dd>
              <dt className="text-zinc-600">Target learner level</dt>
              <dd>HSK1 · Early beginner</dd>
              <dt className="text-zinc-600">Focus vocab</dt>
              <dd>猫 māo · 狗 gǒu · 鸟 niǎo · 牛 niú · 马 mǎ</dd>
              <dt className="text-zinc-600">Support vocab</dt>
              <dd>这 zhè · 是 shì · 在 zài · 看 kàn</dd>
              <dt className="text-zinc-600">Teaching goal</dt>
              <dd>Recognize and say five common farm animal names.</dd>
              <dt className="text-zinc-600">Scene idea</dt>
              <dd>Baby visits the farm, greeting each animal one by one.</dd>
            </dl>
            <CandidateActions selected={selectedIdea === 1} onSelect={() => setSelectedIdea(1)} />
          </section>
          <section>
            <div className="flex gap-3">
              <div className="grid size-8 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[.05]">
                <Sparkles className="size-4 text-amber-300" />
              </div>
              <div>
                <p className="text-[13px] text-zinc-300">
                  Want me to generate <em>5 title ideas</em>?
                </p>
                <div className="mt-3 flex gap-2">
                  <ActionButton primary>Generate 5 titles</ActionButton>
                  <ActionButton>Edit prompt first</ActionButton>
                  <ActionButton>Skip</ActionButton>
                </div>
              </div>
            </div>
          </section>
          <div className="ml-11 grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-white/[.08] bg-[#17191a] p-4">
              <div className="text-[10px] uppercase tracking-wider text-zinc-600">
                Warm & playful
              </div>
              <h3 className="mt-2 text-base font-semibold">Farm Friends Say Hello</h3>
              <p className="mt-1 text-xs text-zinc-500">Clear, friendly, and easy to remember.</p>
              <CandidateActions />
            </div>
            <div className="rounded-xl border border-amber-500/35 bg-amber-500/[.045] p-4">
              <div className="flex justify-between text-[10px] uppercase tracking-wider text-amber-300">
                <span>Curiosity hook</span>
                <Pin className="size-3" />
              </div>
              <h3 className="mt-2 text-base font-semibold">Who’s Making That Sound?</h3>
              <p className="mt-1 text-xs text-zinc-500">Invites learners into the animal reveal.</p>
              <CandidateActions selected />
            </div>
          </div>
          <div className="ml-11">
            <FeedbackBar />
          </div>
        </div>
      </div>
      <div className="border-t border-white/[.07] p-3">
        <div className="mx-auto max-w-3xl rounded-xl border border-white/10 bg-[#171819] p-3 focus-within:border-amber-500/25">
          <textarea
            aria-label="Message"
            rows={1}
            placeholder="Message the studio…"
            className="w-full resize-none bg-transparent text-xs outline-none placeholder:text-zinc-600"
          />
          <div className="mt-2 flex items-center justify-between">
            <div className="flex gap-2">
              <button className="rounded-lg p-1.5 text-zinc-600 hover:text-zinc-300">
                <Paperclip className="size-4" />
              </button>
              <button className="flex items-center gap-1 rounded-lg border border-white/[.07] px-2.5 py-1.5 text-[10px] text-zinc-500">
                GPT-5.5 <ChevronDown className="size-3" />
              </button>
            </div>
            <button className="grid size-8 place-items-center rounded-lg bg-amber-400 text-black hover:bg-amber-300">
              <Send className="size-3.5" />
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

function StatePanel({ selectedIdea }: { selectedIdea: number }) {
  const sections = [
    ["Episode Foundation", selectedIdea ? "Farm animal friends · HSK1" : "Not selected yet"],
    ["Selected Title", "Who’s Making That Sound?"],
    ["Thumbnail Concept", "Not selected yet"],
    ["Outline", "Not selected yet"],
    ["Script", "Not selected yet"],
    ["Publishing", "Not selected yet"],
  ];
  return (
    <aside className="hidden w-[290px] shrink-0 flex-col border-l border-white/[.07] bg-[#111213] xl:flex">
      <div className="flex h-14 items-center justify-between border-b border-white/[.07] px-4">
        <div>
          <h2 className="text-sm font-semibold">Episode state</h2>
          <p className="text-[10px] text-zinc-600">Pinned production decisions</p>
        </div>
        <Pin className="size-4 text-zinc-600" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="space-y-2">
          {sections.map(([label, value], i) => (
            <div
              key={label}
              className={cn(
                "rounded-lg border p-3",
                value !== "Not selected yet"
                  ? "border-amber-500/25 bg-amber-500/[.045]"
                  : "border-white/[.07]",
              )}
            >
              <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                <span>{label}</span>
                {value !== "Not selected yet" && <Pin className="size-3 text-amber-400" />}
              </div>
              <div
                className={cn(
                  "mt-1.5 text-xs",
                  value === "Not selected yet" ? "italic text-zinc-600" : "text-zinc-200",
                )}
              >
                {value}
              </div>
              {i === 0 && value !== "Not selected yet" && (
                <div className="mt-1 text-[10px] text-zinc-500">5 focus · 4 support vocab</div>
              )}
            </div>
          ))}
        </div>
        <div className="mt-5 border-t border-white/[.07] pt-4">
          <div className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
            Workflow
          </div>
          {stages.map((s, i) => (
            <div key={s} className="relative flex items-center gap-3 pb-3 text-[11px]">
              <span
                className={cn(
                  "relative z-10 size-2.5 rounded-full border",
                  i === 0 ? "border-amber-400 bg-amber-400" : "border-zinc-600 bg-[#111213]",
                )}
              />
              {i < stages.length - 1 && (
                <span className="absolute left-[4px] top-2 h-full w-px bg-white/10" />
              )}
              <span className={i === 0 ? "text-amber-300" : "text-zinc-500"}>{s}</span>
              {i === 0 && <span className="ml-auto text-[9px] text-amber-400">In progress</span>}
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

function Kanban({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <main className="min-w-0 flex-1 overflow-auto bg-[#0e0f10] p-5">
      <div className="mb-5 flex items-end justify-between">
        <div>
          <h1 className="text-lg font-semibold">Episode pipeline</h1>
          <p className="mt-1 text-xs text-zinc-600">
            Select a card to open its persistent episode chat.
          </p>
        </div>
        <button className="flex items-center gap-1.5 rounded-lg bg-amber-400 px-3 py-2 text-xs font-semibold text-black">
          <Plus className="size-3.5" />
          New episode
        </button>
      </div>
      <div className="grid min-w-[1480px] grid-cols-8 gap-3">
        {stages.map((stage) => (
          <section key={stage}>
            <div className="mb-2 flex items-center justify-between px-1">
              <h2 className="text-[11px] font-semibold text-zinc-400">{stage}</h2>
              <span className="text-[10px] text-zinc-700">
                {episodes.filter((e) => e.stage === stage).length}
              </span>
            </div>
            <div className="min-h-[70vh] rounded-xl border border-white/[.06] bg-white/[.018] p-2">
              {episodes
                .filter((e) => e.stage === stage)
                .map((e) => (
                  <button
                    onClick={() => onOpen(e.code)}
                    key={e.code}
                    className="mb-2 w-full rounded-lg border border-white/[.08] bg-[#181a1b] p-3 text-left transition hover:border-amber-500/35 hover:-translate-y-px"
                  >
                    <div className="text-[10px] font-semibold text-amber-300">{e.code}</div>
                    <div className="mt-2 text-xs font-medium leading-5 text-zinc-200">
                      {e.title}
                    </div>
                    <div className="mt-4 border-t border-white/[.06] pt-2 text-[9px] text-zinc-600">
                      <div>{e.meta}</div>
                      <div className="mt-1">{e.updated}</div>
                    </div>
                    <div className="mt-3 flex items-center gap-1 text-[9px] text-zinc-500">
                      Open chat <ArrowUp className="size-2.5 rotate-45" />
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

export function CreateRoomMockup() {
  const [view, setView] = useState<"chat" | "kanban">("chat");
  const [selected, setSelected] = useState("LCB-007");
  const [selectedIdea, setSelectedIdea] = useState(1);
  return (
    <div className="dark flex h-dvh flex-col overflow-hidden bg-[#0d0e0f] font-sans text-zinc-300">
      <header className="flex h-[72px] shrink-0 items-center justify-between border-b border-white/[.07] bg-[#101112] px-4">
        <div className="flex items-center gap-4">
          <div className="grid size-9 place-items-center rounded-xl border border-white/15 text-[11px] font-bold text-zinc-200">
            LCB
          </div>
          <div className="h-8 w-px bg-white/[.08]" />
          <WorkspaceSwitcher />
        </div>
        <div className="flex items-center gap-2">
          <button className="rounded-lg px-3 py-2 text-xs text-zinc-500 hover:bg-white/5">
            Help
          </button>
          <div className="grid size-8 place-items-center rounded-full bg-white/[.08] text-[10px] font-semibold">
            CR
          </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <EpisodeSidebar
          view={view}
          setView={setView}
          selected={selected}
          setSelected={setSelected}
        />
        {view === "chat" ? (
          <>
            <ChatView selectedIdea={selectedIdea} setSelectedIdea={setSelectedIdea} />
            <StatePanel selectedIdea={selectedIdea} />
          </>
        ) : (
          <Kanban
            onOpen={(id) => {
              setSelected(id);
              setView("chat");
            }}
          />
        )}
      </div>
    </div>
  );
}
