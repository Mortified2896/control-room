"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Chat = {
  id: string;
  title: string;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type RouteInfo = {
  taskType: string;
  route: string;
  model: string;
  reasoning: string;
  estimatedCost: string;
  status: string;
  trace: string;
  recentEvents: string[];
};

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const PROJECTS = ["Control Room", "Hermes WebUI", "Finance Tools"];

const CHATS_BY_PROJECT: Record<string, Chat[]> = {
  "Control Room": [
    { id: "c1", title: "Design MVP interface" },
    { id: "c2", title: "Hermes WebUI service cleanup" },
    { id: "c3", title: "Compare v0 vs Figma" },
    { id: "c4", title: "Finance Article Studio ideas" },
  ],
  "Hermes WebUI": [
    { id: "h1", title: "Error handling review" },
    { id: "h2", title: "API route refactor" },
  ],
  "Finance Tools": [
    { id: "f1", title: "Portfolio tracker" },
    { id: "f2", title: "Market data feed" },
  ],
};

const MESSAGES: Message[] = [
  {
    id: "m1",
    role: "user",
    content:
      "Create a Control Room MVP design that feels like ChatGPT but adds model routing and feedback notes.",
  },
  {
    id: "m2",
    role: "assistant",
    content: `## Control Room design direction

The MVP keeps chat as the primary interface, just like ChatGPT. Model routing,
approval state, trace links, and per-response feedback notes are layered in
without turning the app into a heavy dashboard.

Every message gets a lightweight set of actions—thumbs, copy, retry—plus the
option to attach a short feedback note. The right panel shows route details and
approval state at a glance, but stays visually secondary. The goal is to feel
like a daily-use workbench, not a monitoring dashboard.

**MVP checklist:**
- [ ] Project-grouped chat history
- [ ] Model and reasoning selectors
- [ ] Per-response feedback notes linked to the answer
- [ ] Route approval before execution
- [ ] Langfuse trace link per run`,
  },
];

const ROUTE_INFO: RouteInfo = {
  taskType: "UI design",
  route: "ChatGPT → design mockup",
  model: "GPT-5.5",
  reasoning: "Small",
  estimatedCost: "low",
  status: "Ready for approval",
  trace: "pending",
  recentEvents: [
    "Route selected — ChatGPT → design mockup",
    "Model assigned — GPT-5.5",
    "Reasoning set — Small",
    "Awaiting approval",
  ],
};

const MODELS = [
  "Default",
  "GPT-5.5",
  "GPT-5.5 Small",
  "MiniMax M3",
  "Claude",
  "Hermes",
  "OpenCode",
];

const REASONING_OPTIONS = ["Small", "Medium", "High"];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SearchInput() {
  return (
    <div className="relative">
      <svg
        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/50"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="m21 21-4.35-4.35M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z"
        />
      </svg>
      <input
        type="text"
        placeholder="Search chats…"
        className="w-full rounded-lg border border-border/50 bg-muted/30 py-1.5 pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-muted-foreground/30 focus:outline-none"
      />
    </div>
  );
}

function ProjectItem({ label, active }: { label: string; active: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs font-medium transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/40 hover:text-accent-foreground",
      )}
    >
      <svg
        className="size-3.5 shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z"
        />
      </svg>
      {label}
    </button>
  );
}

function ChatItem({
  chat,
  active,
  onSelect,
}: {
  chat: Chat;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(chat.id)}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs transition-colors",
        active
          ? "bg-primary/10 text-foreground font-medium"
          : "text-muted-foreground/80 hover:bg-accent/30 hover:text-foreground",
      )}
    >
      <svg
        className="size-3.5 shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155"
        />
      </svg>
      <span className="truncate">{chat.title}</span>
    </button>
  );
}

function ModelSelector() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(MODELS[1]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/20 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/40"
      >
        {selected}
        <svg
          className="size-3"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 bottom-full z-50 mb-1 w-44 overflow-hidden rounded-xl border border-border/60 bg-popover py-1 shadow-lg">
            {MODELS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setSelected(m);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center px-3 py-1.5 text-xs transition-colors",
                  m === selected
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-popover-foreground hover:bg-accent/50",
                )}
              >
                {m}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ReasoningSelector() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(REASONING_OPTIONS[0]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/20 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/40"
      >
        Reasoning: {selected}
        <svg
          className="size-3"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 bottom-full z-50 mb-1 w-36 overflow-hidden rounded-xl border border-border/60 bg-popover py-1 shadow-lg">
            {REASONING_OPTIONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => {
                  setSelected(r);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center px-3 py-1.5 text-xs transition-colors",
                  r === selected
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-popover-foreground hover:bg-accent/50",
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function RoutePill() {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/25 bg-amber-500/10 px-3 py-1 text-xs text-amber-400/80">
      <svg className="size-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 6.75V15m6-6v8.25m.503 3.498 4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 0 0-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0Z"
        />
      </svg>
      <span>
        Route: <span className="text-amber-300">ChatGPT → design mockup</span>
      </span>
    </div>
  );
}

function ComposerBar() {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="flex items-end gap-2 rounded-2xl border border-border/60 bg-muted/20 px-4 py-3 shadow-sm transition-colors focus-within:border-muted-foreground/30">
        <button
          type="button"
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:text-muted-foreground"
        >
          <svg
            className="size-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32m.009-.01-.01.01m5.699-9.941-7.81 7.81a1.5 1.5 0 0 0 2.112 2.13"
            />
          </svg>
        </button>

        <input
          type="text"
          placeholder="Message Control Room…"
          className="min-h-0 flex-1 resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 outline-none"
        />

        <button
          type="button"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-90"
        >
          <svg
            className="size-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25"
            />
          </svg>
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 px-1">
        <ModelSelector />
        <ReasoningSelector />
        <RoutePill />
      </div>
    </div>
  );
}

function FeedbackNote() {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="mt-3 rounded-xl border border-border/50 bg-muted/15 px-3.5 py-2.5">
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        className="flex w-full items-center gap-2 text-xs text-muted-foreground"
      >
        <svg
          className="size-3.5 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10"
          />
        </svg>
        <span className="font-medium">Feedback note</span>
        <svg
          className={cn("ml-auto size-3 transition-transform", expanded && "rotate-180")}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 15.75 7.5-7.5 7.5 7.5" />
        </svg>
      </button>

      {expanded && (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground/80">
          Good structure, but make Route Inspector less dominant.
        </p>
      )}
    </div>
  );
}

function MessageActions({
  showFeedback,
  onToggleFeedback,
}: {
  showFeedback: boolean;
  onToggleFeedback: () => void;
}) {
  const [vote, setVote] = useState<"up" | "down" | null>(null);

  return (
    <div className="mt-2 flex items-center gap-0.5">
      <ActionButton
        tooltip="Good response"
        active={vote === "up"}
        onClick={() => setVote(vote === "up" ? null : "up")}
      >
        <svg
          className="size-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M6.633 10.25c.806 0 1.533-.446 2.031-1.08a9.041 9.041 0 0 1 2.861-2.4c.723-.384 1.35-.956 1.653-1.715a4.498 4.498 0 0 0 .322-1.672V2.75a.75.75 0 0 1 .75-.75 2.25 2.25 0 0 1 2.25 2.25c0 1.152-.26 2.243-.723 3.218-.266.558.107 1.282.725 1.282m0 0h3.126c1.026 0 1.945.694 2.064 1.715a11.169 11.169 0 0 1-.043 1.847c-.148.812-.69 1.496-1.464 1.733-.326.1-.664.172-1.012.203m-7.223-.406v7.25m0 0h-1.4a1.75 1.75 0 0 1-1.75-1.75V10.25c0-.966.784-1.75 1.75-1.75h1.4m0 0h1.4a1.75 1.75 0 0 1 1.75 1.75v7.25c0 .966-.784 1.75-1.75 1.75h-1.4"
          />
        </svg>
      </ActionButton>

      <ActionButton
        tooltip="Bad response"
        active={vote === "down"}
        onClick={() => setVote(vote === "down" ? null : "down")}
      >
        <svg
          className="size-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M17.367 13.75c-.806 0-1.533.446-2.031 1.08a9.042 9.042 0 0 1-2.861 2.4c-.723.384-1.35.956-1.653 1.715a4.5 4.5 0 0 0-.322 1.672v1.103a.75.75 0 0 1-.75.75 2.25 2.25 0 0 1-2.25-2.25c0-1.152.26-2.243.723-3.218.266-.558-.107-1.282-.725-1.282m0 0H5.622c-1.026 0-1.945-.694-2.064-1.715a11.169 11.169 0 0 1 .043-1.847c.149-.812.69-1.496 1.464-1.733.326-.1.664-.172 1.012-.203m7.223.407v-7.25m0 0h1.4a1.75 1.75 0 0 1 1.75 1.75v7.25c0 .966-.784 1.75-1.75 1.75h-1.4m0 0h-1.4a1.75 1.75 0 0 1-1.75-1.75V10.25c0-.966.784-1.75 1.75-1.75h1.4"
          />
        </svg>
      </ActionButton>

      <div className="mx-1 h-4 w-px bg-border/50" />

      <ActionButton tooltip="Copy">
        <svg
          className="size-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75"
          />
        </svg>
      </ActionButton>

      <ActionButton tooltip="Regenerate">
        <svg
          className="size-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182"
          />
        </svg>
      </ActionButton>

      <div className="mx-1 h-4 w-px bg-border/50" />

      <ActionButton
        tooltip="Attach feedback"
        active={showFeedback}
        onClick={onToggleFeedback}
      >
        <svg
          className="size-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125"
          />
        </svg>
      </ActionButton>
    </div>
  );
}

function ActionButton({
  children,
  tooltip,
  active,
  onClick,
}: {
  children: React.ReactNode;
  tooltip: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={tooltip}
      onClick={onClick}
      className={cn(
        "flex size-7 items-center justify-center rounded-full text-muted-foreground/50 transition-colors hover:text-muted-foreground hover:bg-muted/30",
        active && "text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function UserMessageBubble({ content }: { content: string }) {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-xs font-medium text-foreground">
          U
        </div>
        <div className="min-w-0 flex-1 pt-1">
          <p className="text-sm leading-relaxed text-foreground">{content}</p>
        </div>
      </div>
    </div>
  );
}

function AssistantMessage({ content }: { content: string }) {
  const [showFeedback, setShowFeedback] = useState(false);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border/40 bg-muted/20 text-xs font-medium text-foreground">
          CR
        </div>
        <div className="min-w-0 flex-1 pt-1">
          <div className="prose prose-sm prose-invert max-w-none">
            {content.split("\n").map((line, i) => {
              if (line.startsWith("## ")) {
                return (
                  <h2 key={i} className="mt-4 mb-2 text-base font-semibold text-foreground">
                    {line.slice(3)}
                  </h2>
                );
              }
              if (line.startsWith("**") && line.endsWith("**")) {
                return (
                  <p key={i} className="font-semibold text-foreground">
                    {line.slice(2, -2)}
                  </p>
                );
              }
              if (line.startsWith("- [ ] ")) {
                return (
                  <div key={i} className="flex items-start gap-2 py-0.5">
                    <div className="mt-0.5 size-3.5 shrink-0 rounded-sm border border-muted-foreground/40" />
                    <span className="text-sm text-muted-foreground">{line.slice(6)}</span>
                  </div>
                );
              }
              if (line.trim() === "") {
                return <div key={i} className="h-2" />;
              }
              return (
                <p key={i} className="text-sm leading-relaxed text-muted-foreground">
                  {line}
                </p>
              );
            })}
          </div>

          <MessageActions
            showFeedback={showFeedback}
            onToggleFeedback={() => setShowFeedback((p) => !p)}
          />
          {showFeedback && <FeedbackNote />}
        </div>
      </div>
    </div>
  );
}

function MessageList() {
  return (
    <div className="flex flex-col gap-8 py-6">
      {MESSAGES.map((msg) =>
        msg.role === "user" ? (
          <UserMessageBubble key={msg.id} content={msg.content} />
        ) : (
          <AssistantMessage key={msg.id} content={msg.content} />
        ),
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Route Inspector (right panel)
// ---------------------------------------------------------------------------

function RouteInspector() {
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <div className="flex h-full w-10 flex-col items-center border-l border-border/50 bg-muted/5 pt-4">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground/50 transition-colors hover:text-muted-foreground"
          title="Expand route inspector"
        >
          <svg
            className="size-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full w-72 flex-col border-l border-border/50 bg-muted/5">
      <div className="flex items-center justify-between border-b border-border/30 px-3.5 py-2.5">
        <h3 className="text-xs font-medium text-muted-foreground">Route Inspector</h3>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="flex size-6 items-center justify-center rounded text-muted-foreground/40 transition-colors hover:text-muted-foreground"
          title="Collapse"
        >
          <svg
            className="size-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 19.5-7.5-7.5 7.5-7.5" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3.5 py-3">
        <div className="space-y-3">
          <DetailRow label="Task type" value={ROUTE_INFO.taskType} />
          <DetailRow label="Route" value={ROUTE_INFO.route} />
          <DetailRow label="Model" value={ROUTE_INFO.model} />
          <DetailRow label="Reasoning" value={ROUTE_INFO.reasoning} />
          <DetailRow label="Est. cost" value={ROUTE_INFO.estimatedCost} />

          <div className="pt-1">
            <div className="flex items-center justify-between rounded-lg border border-border/30 bg-muted/10 px-3 py-2">
              <span className="text-xs text-muted-foreground">Status</span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-0.5 text-xs text-amber-400">
                <span className="size-1.5 rounded-full bg-amber-400" />
                {ROUTE_INFO.status}
              </span>
            </div>
          </div>

          {/* Approve run button */}
          <button
            type="button"
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-400 transition-colors hover:bg-emerald-500/20"
          >
            <svg
              className="size-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
            </svg>
            Approve run
          </button>

          {/* Langfuse trace placeholder */}
          <div className="rounded-lg border border-border/30 bg-muted/10 px-3 py-2.5">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <svg
                className="size-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3.75 3v11.25A2.25 2.25 0 0 0 6 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0 1 18 16.5h-2.25m-7.5 0h7.5m-7.5 0-1 3m8.5-3 1 3m0 0 .5 1.5m-.5-1.5h-9.5m0 0-.5 1.5m.75-9 3-3 2.148 2.148A12.061 12.061 0 0 1 16.5 7.605"
                />
              </svg>
              <span>Langfuse trace</span>
              <span className="ml-auto rounded bg-muted/20 px-1.5 py-0.5 text-[10px] text-muted-foreground/60">
                pending
              </span>
            </div>
          </div>

          {/* Recent run events */}
          <div>
            <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
              Recent events
            </h4>
            <div className="space-y-1.5">
              {ROUTE_INFO.recentEvents.map((event, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 text-[11px] text-muted-foreground/60"
                >
                  <span className="mt-1 size-1 shrink-0 rounded-full bg-muted-foreground/30" />
                  {event}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-muted-foreground/60">{label}</span>
      <span className="text-xs text-muted-foreground">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Left Sidebar
// ---------------------------------------------------------------------------

function LeftSidebar() {
  const [selectedProject] = useState(PROJECTS[0]);
  const [selectedChatId, setSelectedChatId] = useState("c1");

  const currentChats = selectedProject ? (CHATS_BY_PROJECT[selectedProject] ?? []) : [];

  return (
    <div className="flex h-full w-64 flex-col border-r border-border/50 bg-muted/5">
      {/* Header */}
      <div className="border-b border-border/30 px-4 py-3.5">
        <h1 className="text-sm font-semibold text-foreground">Control Room</h1>
        <p className="text-[11px] text-muted-foreground/60">Personal AI workbench</p>
      </div>

      {/* New Chat */}
      <div className="px-3 pt-3">
        <button
          type="button"
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border/50 bg-muted/20 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
        >
          <svg
            className="size-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          New Chat
        </button>
      </div>

      {/* Search */}
      <div className="px-3 pt-3">
        <SearchInput />
      </div>

      {/* Projects */}
      <div className="px-3 pt-3">
        <h2 className="mb-1.5 px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
          Projects
        </h2>
        <div className="space-y-0.5">
          {PROJECTS.map((project) => (
            <ProjectItem key={project} label={project} active={project === selectedProject} />
          ))}
        </div>
      </div>

      {/* Chats */}
      <div className="flex-1 overflow-y-auto px-3 pt-3 pb-2">
        <h2 className="mb-1.5 px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
          Recent chats
        </h2>
        <div className="space-y-0.5">
          {currentChats.map((chat) => (
            <ChatItem
              key={chat.id}
              chat={chat}
              active={chat.id === selectedChatId}
              onSelect={setSelectedChatId}
            />
          ))}
        </div>
      </div>

      {/* Profile / Settings */}
      <div className="border-t border-border/30 px-3 py-2.5">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground/60 transition-colors hover:bg-muted/20 hover:text-muted-foreground"
        >
          <div className="flex size-6 items-center justify-center rounded-full bg-muted/30 text-[10px] font-medium">
            U
          </div>
          <span>User Settings</span>
          <svg
            className="ml-auto size-3"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main layout
// ---------------------------------------------------------------------------

export function ControlRoomMockup() {
  return (
    <div className="mockup-light flex h-dvh bg-background text-foreground">
      <style>{`
        .mockup-light {
          color-scheme: light;
          --background: oklch(1 0 0);
          --foreground: oklch(0.141 0.005 285.823);
          --card: oklch(1 0 0);
          --card-foreground: oklch(0.141 0.005 285.823);
          --popover: oklch(1 0 0);
          --popover-foreground: oklch(0.141 0.005 285.823);
          --primary: oklch(0.21 0.006 285.885);
          --primary-foreground: oklch(0.985 0 0);
          --secondary: oklch(0.967 0.001 286.375);
          --secondary-foreground: oklch(0.21 0.006 285.885);
          --muted: oklch(0.967 0.001 286.375);
          --muted-foreground: oklch(0.552 0.016 285.938);
          --accent: oklch(0.967 0.001 286.375);
          --accent-foreground: oklch(0.21 0.006 285.885);
          --destructive: oklch(0.577 0.245 27.325);
          --border: oklch(0.92 0.004 286.32);
          --input: oklch(0.92 0.004 286.32);
          --ring: oklch(0.705 0.015 286.067);
          --chart-1: oklch(0.646 0.222 41.116);
          --chart-2: oklch(0.6 0.118 184.704);
          --chart-3: oklch(0.398 0.07 227.392);
          --chart-4: oklch(0.828 0.189 84.429);
          --chart-5: oklch(0.769 0.188 70.08);
        }
      `}</style>
      {/* Left Sidebar */}
      <LeftSidebar />

      {/* Center chat area */}
      <div className="flex flex-1 flex-col min-w-0">
        <div className="flex-1 overflow-y-auto">
          <MessageList />
        </div>

        {/* Composer */}
        <div className="border-t border-border/30 px-4 py-3">
          <ComposerBar />
        </div>
      </div>

      {/* Right Route Inspector */}
      <RouteInspector />
    </div>
  );
}
