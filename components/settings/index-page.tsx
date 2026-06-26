"use client";

import { useState, type ReactNode } from "react";
import { Bot, Sparkles, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AgentBackendsPage } from "@/components/settings/agent-backends-page";
import { RouterSettingsPage } from "@/components/settings/router-settings-page";
import { cn } from "@/lib/utils";

type SettingsTab = "codex" | "openai" | "minimax";

const TABS: ReadonlyArray<{
  id: SettingsTab;
  label: string;
  description: string;
  icon: ReactNode;
}> = [
  {
    id: "codex",
    label: "Codex subscription",
    description: "Codex CLI + ChatGPT subscription backend and chat selector options.",
    icon: <Bot className="size-4" />,
  },
  {
    id: "openai",
    label: "OpenAI API",
    description: "OPENAI_API_KEY models, manual visibility, and OpenAI-only Router A/B.",
    icon: <Sparkles className="size-4" />,
  },
  {
    id: "minimax",
    label: "MiniMax API key",
    description: "MINIMAX_API_KEY model access and MiniMax token-plan status.",
    icon: <Zap className="size-4" />,
  },
];

export function SettingsIndexPage() {
  const [tab, setTab] = useState<SettingsTab>("codex");
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <div className="mx-auto flex h-dvh w-full max-w-6xl flex-col gap-5 overflow-y-auto px-4 py-6 sm:px-8">
      <header className="space-y-2 border-b border-border/60 pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Provider and backend settings in one place. Use provider tabs to control manual chat
            visibility, router eligibility, and backend access paths.
          </p>
        </div>
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Settings provider tabs">
          {TABS.map((item) => (
            <Button
              key={item.id}
              type="button"
              variant={tab === item.id ? "default" : "outline"}
              size="sm"
              onClick={() => setTab(item.id)}
              role="tab"
              aria-selected={tab === item.id}
              className={cn("gap-2", tab !== item.id && "bg-background")}
            >
              {item.icon}
              {item.label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{active.description}</p>
      </header>

      <div role="tabpanel" className="min-h-0 flex-1">
        {tab === "codex" ? (
          <AgentBackendsPage embedded />
        ) : tab === "openai" ? (
          <RouterSettingsPage embedded providerFilter="openai" />
        ) : (
          <RouterSettingsPage embedded providerFilter="minimax" />
        )}
      </div>
    </div>
  );
}
