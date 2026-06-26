"use client";

import { useCallback, useEffect, useState, type FC } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Loader2,
  RefreshCw,
  Send,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Agent Backends — Codex card.
 *
 * This page is a *backend test* surface for the Codex CLI on the
 * server. It is intentionally NOT wired into the chat composer, the
 * model picker, or the Router A/B flow. Codex is an agent execution
 * backend authenticated via the operator's ChatGPT subscription; it
 * is not a model provider that replaces OpenAI in the existing chat
 * pipeline.
 *
 * The MVP exposes:
 *   - Status pill (connected / not connected / not installed / error)
 *   - CLI path + version
 *   - Auth type (chatgpt / api_key / unknown)
 *   - Manual refresh button
 *   - Manual login instruction (device-auth flow) when not logged in
 *   - A "Send test message" form that POSTs to
 *     `/api/agent-backends/codex/chat` with a configurable prompt.
 *
 * Hard constraints:
 *   - The form input is sent verbatim to `codex exec` as a single
 *     positional argument via `execFile`. It is never interpreted as
 *     a shell command or as CLI flags.
 *   - Codex runs in `/home/hermes/tmp/control-room-codex-smoke` with
 *     `--skip-git-repo-check`, `approval="never"`, and
 *     `sandbox="read-only"`. The control-room repo is never touched.
 *   - No secrets are displayed or logged.
 *   - 120s timeout on the underlying `codex exec` call.
 */

type CodexAuthType = "chatgpt" | "api_key" | "unknown";
type CodexStatus = "not_installed" | "not_logged_in" | "logged_in" | "error";

type CodexStatusDto = {
  status: CodexStatus;
  binary: {
    path: string | null;
    version: string | null;
    resolvedFrom: "env" | "PATH" | null;
  };
  auth: {
    type: CodexAuthType | null;
    accountHint: string | null;
    authFile: string | null;
    storageMode: "file" | null;
  };
  usingSubscription: boolean;
  lastCheckedAt: string;
  errorMessage: string | null;
};

type CodexModelId = "gpt-5.4-mini" | "gpt-5.5";

type CodexChatResponse = {
  ok: boolean;
  responseText: string | null;
  error: string | null;
  exitCode: number | null;
};

const CODEX_MODELS: ReadonlyArray<{ id: CodexModelId; label: string; description: string }> = [
  {
    id: "gpt-5.4-mini",
    label: "Codex · GPT-5.4 Mini",
    description: "Access: Codex CLI · ChatGPT subscription",
  },
  {
    id: "gpt-5.5",
    label: "Codex · GPT-5.5",
    description: "Access: Codex CLI · ChatGPT subscription",
  },
];

type ChatState =
  | { kind: "idle" }
  | { kind: "sending"; message: string }
  | { kind: "ok"; at: number; payload: CodexChatResponse }
  | { kind: "error"; at: number; payload: CodexChatResponse };

type RefreshState =
  | { kind: "idle" }
  | { kind: "refreshing" }
  | { kind: "refreshed"; at: number }
  | { kind: "error"; at: number; message: string };

const STATUS_PILL: Record<
  CodexStatus,
  { label: string; classes: string; icon: FC<{ className?: string }> }
> = {
  logged_in: {
    label: "Connected",
    classes: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/30",
    icon: CheckCircle2,
  },
  not_logged_in: {
    label: "Not connected",
    classes: "bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-500/30",
    icon: AlertTriangle,
  },
  not_installed: {
    label: "Not installed",
    classes: "bg-muted text-muted-foreground ring-border",
    icon: XCircle,
  },
  error: {
    label: "Error",
    classes: "bg-destructive/10 text-destructive ring-destructive/30",
    icon: AlertTriangle,
  },
};

const AUTH_TYPE_LABEL: Record<CodexAuthType, string> = {
  chatgpt: "ChatGPT account (uses included subscription)",
  api_key: "API key (not used by Control Room)",
  unknown: "Unknown",
};

function relativeTime(iso: string, now: number): string {
  const ms = now - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

export function AgentBackendsPage() {
  const [status, setStatus] = useState<CodexStatusDto | null>(null);
  const [refresh, setRefresh] = useState<RefreshState>({ kind: "idle" });
  const [chat, setChat] = useState<ChatState>({ kind: "idle" });
  const [draft, setDraft] = useState<string>("Reply with only: pong");
  const [codexModel, setCodexModel] = useState<CodexModelId>("gpt-5.4-mini");
  const [now, setNow] = useState<number>(() => Date.now());

  const loadStatus = useCallback(async () => {
    setRefresh({ kind: "refreshing" });
    try {
      const r = await fetch("/api/agent-backends/codex/status", {
        cache: "no-store",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const dto = (await r.json()) as CodexStatusDto;
      setStatus(dto);
      setRefresh({ kind: "refreshed", at: Date.now() });
    } catch (err) {
      setRefresh({
        kind: "error",
        at: Date.now(),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Tick the "X seconds ago" label once a second.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const sendChat = useCallback(async () => {
    const message = draft.trim();
    if (!message) return;
    setChat({ kind: "sending", message });
    try {
      const r = await fetch("/api/agent-backends/codex/chat", {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, model: codexModel }),
      });
      const payload = (await r.json()) as CodexChatResponse;
      // We treat both HTTP 200 with `ok: true` and HTTP 200/503 with
      // `ok: false` as the same response shape — the body is always
      // structured. We only separate "ok" vs "error" for UI styling.
      if (payload.ok) {
        setChat({ kind: "ok", at: Date.now(), payload });
      } else {
        setChat({ kind: "error", at: Date.now(), payload });
      }
    } catch (err) {
      setChat({
        kind: "error",
        at: Date.now(),
        payload: {
          ok: false,
          responseText: null,
          exitCode: null,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }, [draft, codexModel]);

  const pill = status ? STATUS_PILL[status.status] : null;
  const PillIcon = pill?.icon ?? Loader2;
  const chatDisabled = !status || status.status !== "logged_in" || chat.kind === "sending";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon-sm" aria-label="Back to settings">
          <Link href="/settings">
            <ArrowLeft />
          </Link>
        </Button>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Agent Backends</h1>
          <p className="text-sm text-muted-foreground">
            Backends that can execute tasks on the server. Status is read-only and refreshed on
            demand. These are not chat model providers.
          </p>
        </div>
      </div>

      {/* Codex status card */}
      <section
        className="rounded-lg border border-border/60 bg-card/50 p-5 shadow-xs"
        aria-label="Codex backend status"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">Codex</h2>
              {status?.binary.version ? (
                <span className="rounded bg-muted/60 px-2 py-0.5 font-mono text-xs text-muted-foreground">
                  v{status.binary.version}
                </span>
              ) : null}
              {pill ? (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
                    pill.classes,
                  )}
                  data-testid="codex-status-pill"
                  data-status={status?.status ?? "loading"}
                >
                  <PillIcon className="size-3.5" />
                  {pill.label}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground ring-1 ring-inset ring-border">
                  <Loader2 className="size-3.5 animate-spin" />
                  Checking…
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Access: Codex CLI + ChatGPT login. Billing/access: ChatGPT/Codex subscription when
              usingSubscription=true. This backend does not use OPENAI_API_KEY and is not API
              billed.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadStatus()}
                  disabled={refresh.kind === "refreshing"}
                  aria-label="Refresh Codex status"
                >
                  <RefreshCw
                    className={cn("size-3.5", refresh.kind === "refreshing" ? "animate-spin" : "")}
                  />
                  Refresh
                </Button>
              </TooltipTrigger>
              <TooltipContent>Runs `codex --version` and `codex login status`.</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div className="space-y-0.5">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">CLI path</dt>
            <dd className="break-all font-mono text-xs">
              {status?.binary.path ?? (
                <span className="text-muted-foreground">not found on server</span>
              )}
            </dd>
          </div>
          <div className="space-y-0.5">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Access path</dt>
            <dd>Codex CLI + ChatGPT login</dd>
          </div>
          <div className="space-y-0.5">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Auth type</dt>
            <dd>
              {status ? (
                status.auth.type ? (
                  <span>
                    {status.auth.type} · {AUTH_TYPE_LABEL[status.auth.type]}
                  </span>
                ) : status.status === "not_logged_in" ? (
                  <span className="text-muted-foreground">not logged in</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </dd>
          </div>
          <div className="space-y-0.5">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Last checked</dt>
            <dd>
              {status ? (
                <span title={new Date(status.lastCheckedAt).toLocaleString()}>
                  {relativeTime(status.lastCheckedAt, now)}
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </dd>
          </div>
          <div className="space-y-0.5">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
              usingSubscription
            </dt>
            <dd>
              {status?.usingSubscription ? (
                <span className="text-emerald-700 dark:text-emerald-300">
                  using ChatGPT subscription
                </span>
              ) : (
                <span className="text-muted-foreground">not active</span>
              )}
            </dd>
          </div>
        </dl>

        {status?.status === "not_installed" ? (
          <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
            <p className="font-medium text-amber-700 dark:text-amber-300">
              Codex CLI is not installed on this server.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Run on the server:
              <code className="ml-1 rounded bg-muted px-1 py-0.5 font-mono">
                npm install -g @openai/codex
              </code>
              . Then refresh this page.
            </p>
          </div>
        ) : null}

        {status?.status === "not_logged_in" ? (
          <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
            <p className="font-medium text-amber-700 dark:text-amber-300">
              Codex is installed but not logged in.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              On the server, run:
              <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono">
                codex login --device-auth
              </code>
              Then open the URL it prints, sign in to ChatGPT, and enter the one-time code. After
              the device confirms, refresh this page.
            </p>
          </div>
        ) : null}

        {status?.status === "error" ? (
          <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <p className="font-medium text-destructive">Could not determine Codex state.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {status.errorMessage ?? "Unknown error."} Check that the Codex CLI is reachable and
              try Refresh.
            </p>
          </div>
        ) : null}

        {refresh.kind === "error" ? (
          <p className="mt-3 text-xs text-destructive">Refresh failed: {refresh.message}</p>
        ) : null}
      </section>

      {/* Codex backend test */}
      <section
        className="rounded-lg border border-border/60 bg-card/50 p-5 shadow-xs"
        aria-label="Codex backend test"
      >
        <div className="space-y-1">
          <h2 className="text-base font-semibold">Codex backend test</h2>
          <p className="text-xs text-muted-foreground">
            Sends the prompt below to <code className="font-mono">codex exec --model</code> in a
            hermes-owned scratch directory (
            <code className="font-mono">~/tmp/control-room-codex-smoke</code>), with approval
            prompts disabled and the sandbox set to read-only. This page does not touch the
            control-room repo, your projects, or your OpenAI key.
          </p>
        </div>

        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void sendChat();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="codex-model">Codex model</Label>
            <select
              id="codex-model"
              value={codexModel}
              onChange={(e) => setCodexModel(e.target.value as CodexModelId)}
              disabled={chatDisabled}
              className="border-input bg-background flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs outline-none"
            >
              {CODEX_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {CODEX_MODELS.find((m) => m.id === codexModel)?.description}. This does not use
              OPENAI_API_KEY and is not API billed.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="codex-prompt">Prompt</Label>
            <Input
              id="codex-prompt"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Reply with only: pong"
              maxLength={4000}
              disabled={chatDisabled}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              The prompt is passed verbatim to <code className="font-mono">codex exec</code>. It is
              not a shell command and cannot start arbitrary processes.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={chatDisabled || draft.trim().length === 0}
              aria-label="Send test message to Codex"
            >
              {chat.kind === "sending" ? <Loader2 className="size-3.5 animate-spin" /> : <Send />}
              Send test message
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDraft("Reply with only: pong")}
              disabled={chat.kind === "sending"}
            >
              Reset prompt
            </Button>
          </div>
        </form>

        {/* Chat result */}
        {chat.kind === "sending" ? (
          <div className="mt-4 rounded-md border border-border/60 bg-muted/30 p-3 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Sending to Codex ({CODEX_MODELS.find((m) => m.id === codexModel)?.label})…
            </div>
            <p className="mt-2 font-mono text-xs text-muted-foreground">&gt; {chat.message}</p>
          </div>
        ) : chat.kind === "ok" ? (
          <div className="mt-4 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="size-4" />
              Codex responded (exit {chat.payload.exitCode})
            </div>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-background/60 p-2 font-mono text-xs">
              {chat.payload.responseText || "(empty response)"}
            </pre>
          </div>
        ) : chat.kind === "error" ? (
          <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium text-destructive">
              <XCircle className="size-4" />
              Codex did not produce a response
              {chat.payload.exitCode != null ? ` (exit ${chat.payload.exitCode})` : ""}
            </div>
            <p className="mt-2 text-xs text-destructive/90">{chat.payload.error}</p>
          </div>
        ) : null}
      </section>

      <p className="text-center text-xs text-muted-foreground">
        <Link
          className="inline-flex items-center gap-1 hover:text-foreground"
          href="https://developers.openai.com/codex/auth"
          target="_blank"
          rel="noreferrer noopener"
        >
          Codex authentication docs
          <ExternalLink className="size-3" />
        </Link>
      </p>
    </div>
  );
}
