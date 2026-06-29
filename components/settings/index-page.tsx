"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, ChevronDown, ChevronRight, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { RouterSettingsPage } from "@/components/settings/router-settings-page";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

type ProviderAccess = {
  provider_id: "codex_subscription" | "openai_api" | "minimax_api";
  display_name: string;
  enabled: boolean;
  allow_manual: boolean;
  allow_router: boolean;
  allow_backend_test: boolean;
  requires_confirmation_when_enabling: boolean;
  billing_type: "included_subscription" | "usage_billed" | "token_plan";
  access_label: string;
  status: string;
};

function billingLabel(p: ProviderAccess) {
  if (p.provider_id === "codex_subscription") return "Included / ChatGPT subscription";
  if (p.provider_id === "openai_api") return "Usage billed";
  return "MiniMax token plan / subscription";
}

function accessLabel(p: ProviderAccess) {
  if (p.provider_id === "codex_subscription") return "Codex CLI + ChatGPT login";
  if (p.provider_id === "openai_api") return "OPENAI_API_KEY";
  return "MINIMAX_API_KEY";
}

export function SettingsIndexPage() {
  const [providers, setProviders] = useState<ProviderAccess[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    void fetch("/api/provider-access", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setProviders(j.providers ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load provider access"))
      .finally(() => setLoading(false));
  }, []);

  const save = async (next: ProviderAccess[]) => {
    setProviders(next);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/provider-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: next }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to save provider access");
      setProviders(json.providers ?? next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save provider access");
    } finally {
      setSaving(false);
    }
  };

  const update = (id: ProviderAccess["provider_id"], patch: Partial<ProviderAccess>) => {
    const current = providers.find((p) => p.provider_id === id);
    if (!current) return;
    if (id === "openai_api" && patch.enabled === true && !current.enabled) {
      const ok = window.confirm(
        "OpenAI API uses usage-based billing and can cost real money.\n\n" +
          "Enabling this provider may allow direct API calls if you also enable Manual chat, Router, or Test/Smoke access.\n\n" +
          "Defaults after enabling:\n- Manual chat: OFF\n- Router: OFF\n- Test/Smoke: OFF\n\n" +
          "You can enable each surface manually afterwards.",
      );
      if (!ok) return;
      patch = {
        enabled: true,
        allow_manual: false,
        allow_router: false,
        allow_backend_test: false,
      };
    }
    void save(providers.map((p) => (p.provider_id === id ? { ...p, ...patch } : p)));
  };

  const sorted = useMemo(
    () =>
      ["codex_subscription", "openai_api", "minimax_api"]
        .map((id) => providers.find((p) => p.provider_id === id))
        .filter(Boolean) as ProviderAccess[],
    [providers],
  );

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-5 px-4 py-6 sm:px-8">
      <header className="flex items-start justify-between gap-4 border-b border-border/60 pb-4">
        <div className="flex items-start gap-2">
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            aria-label="Back to chat"
            className="mt-0.5"
          >
            <Link href="/">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
            <p className="text-sm text-muted-foreground">Provider access and model routing</p>
          </div>
        </div>
        <ThemeToggle className="mt-1" />
      </header>

      <section className="rounded-lg border bg-card">
        <button
          className="flex w-full items-center justify-between p-4 text-left"
          onClick={() => setCollapsed((v) => !v)}
        >
          <div>
            <h2 className="font-semibold">Provider Access</h2>
            <p className="text-xs text-muted-foreground">
              Provider-level kill switches are enforced server-side before any model call.
            </p>
          </div>
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
        {!collapsed && (
          <div className="overflow-x-auto border-t">
            {error ? (
              <div className="m-4 rounded-md border border-destructive/40 p-3 text-sm text-destructive">
                {error}
              </div>
            ) : null}
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="p-3 text-left">Provider</th>
                  <th>Status</th>
                  <th>Billing</th>
                  <th>Manual chat</th>
                  <th>Router</th>
                  <th>Test/Smoke</th>
                  <th className="text-left">Notes or access path</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td className="p-4" colSpan={7}>
                      Loading…
                    </td>
                  </tr>
                ) : (
                  sorted.map((p) => (
                    <tr key={p.provider_id} className="border-t">
                      <td className="p-3 font-medium">
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={p.enabled}
                            disabled={saving}
                            onCheckedChange={(v) => update(p.provider_id, { enabled: v })}
                          />
                          {p.display_name}
                          {p.billing_type === "usage_billed" ? (
                            <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
                              <AlertTriangle className="mr-1 inline size-3" />
                              paid
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="p-3">
                        {p.enabled ? (
                          "Enabled"
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <Lock className="size-3" />
                            Disabled
                          </span>
                        )}
                        <div className="text-xs text-muted-foreground">{p.status}</div>
                      </td>
                      <td
                        className={cn(
                          "p-3",
                          p.billing_type === "usage_billed" && "font-semibold text-amber-700",
                        )}
                      >
                        {billingLabel(p)}
                      </td>
                      <td className="p-3 text-center">
                        <Switch
                          checked={p.allow_manual}
                          disabled={saving || !p.enabled}
                          onCheckedChange={(v) => update(p.provider_id, { allow_manual: v })}
                        />
                      </td>
                      <td className="p-3 text-center">
                        <Switch
                          checked={p.allow_router}
                          disabled={saving || !p.enabled}
                          onCheckedChange={(v) => update(p.provider_id, { allow_router: v })}
                        />
                      </td>
                      <td className="p-3 text-center">
                        <Switch
                          checked={p.allow_backend_test}
                          disabled={saving || !p.enabled}
                          onCheckedChange={(v) => update(p.provider_id, { allow_backend_test: v })}
                        />
                      </td>
                      <td className="p-3">
                        {accessLabel(p)}
                        {p.provider_id === "openai_api" ? (
                          <div className="text-xs font-medium text-amber-700">
                            OpenAI API · usage billed; disabled by default.
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <RouterSettingsPage embedded />
    </div>
  );
}
