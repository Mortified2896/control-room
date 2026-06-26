"use client";

import Link from "next/link";
import { ArrowRight, Bot, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Top-level /settings landing page.
 *
 * Two sub-pages exist:
 *   1. Router Settings — controls the model picker + Router A/B
 *      behavior for the chat composer (requires DB).
 *   2. Agent Backends — status + smoke-test surface for non-model
 *      backends like the Codex CLI (no DB required).
 *
 * The Codex card surfaces a tiny live preview by hitting
 * `/api/agent-backends/codex/status` once on mount so the operator
 * can see whether Codex is set up without having to click in.
 */

const SUBTITLE: Record<string, string> = {
  router: "Tune how the chat composer picks models and runs Router A/B side-by-side comparisons.",
  codex:
    "Status + smoke test for the Codex CLI / ChatGPT subscription backend. Does not affect the chat composer.",
};

export function SettingsIndexPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Configure Control Room. Each section is independent — pick one to dig in.
        </p>
      </div>
      <SettingsCard
        href="/settings/router"
        icon={<Sparkles className="size-4" />}
        title="OpenAI API + MiniMax API models"
        subtitle="Manual chat models and the OpenAI-only router. OpenAI uses OPENAI_API_KEY with API billing; MiniMax uses MINIMAX_API_KEY with a MiniMax token plan."
        accent="text-violet-700 dark:text-violet-300 bg-violet-500/10 ring-violet-500/20"
        trailing={
          <div className="flex flex-wrap justify-end gap-1">
            <Badge>OpenAI API</Badge>
            <Badge>MiniMax API</Badge>
          </div>
        }
      />
      <CodexCard />
    </div>
  );
}

function SettingsCard(props: {
  href: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  accent: string;
  trailing?: React.ReactNode;
}) {
  return (
    <Link
      href={props.href}
      className="group flex items-start gap-4 rounded-lg border border-border/60 bg-card/50 p-5 shadow-xs transition-colors hover:border-border hover:bg-card"
    >
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset",
          props.accent,
        )}
      >
        {props.icon}
      </span>
      <div className="flex-1">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{props.title}</h2>
          {props.trailing}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{props.subtitle}</p>
      </div>
      <ArrowRight className="size-4 shrink-0 self-center text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
    </Link>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-muted/60 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

function CodexCard() {
  return (
    <SettingsCard
      href="/settings/agent-backends"
      icon={<Bot className="size-4" />}
      title="Agent Backends"
      subtitle={SUBTITLE.codex}
      accent="text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 ring-emerald-500/20"
      trailing={<Badge>Codex · ChatGPT subscription</Badge>}
    />
  );
}
