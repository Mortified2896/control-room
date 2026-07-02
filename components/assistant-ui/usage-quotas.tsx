"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ChevronDown, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FC } from "react";

export type UsageQuotaProvider = {
  providerId: string;
  label: string;
  accessType: "subscription" | "api" | "local" | "unknown";
  status: "active" | "disabled" | "unknown";
  confidence: "exact" | "estimated" | "unknown";
  estimatedInputTokens?: number | null;
  estimatedOutputTokens?: number | null;
  estimatedTotalTokens?: number | null;
  configuredLimitTokens?: number | null;
  estimatedRemainingTokens?: number | null;
  resetWindowLabel?: string | null;
  recentLimitEvents?: number | null;
  lastUpdated?: string | null;
};

type UsageQuotasResponse = {
  providers: UsageQuotaProvider[];
  recentRuns: Array<{
    providerId: string;
    label: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    at?: string | null;
  }>;
  generatedAt: string;
  source: "local_logs" | "placeholder";
};

const fallbackProviders: UsageQuotaProvider[] = [
  provider("minimax", "MiniMax subscription", "subscription", "active"),
  provider("codex", "Codex subscription", "subscription", "active"),
  provider("openai", "OpenAI API", "api", "disabled"),
];

function provider(
  providerId: string,
  label: string,
  accessType: UsageQuotaProvider["accessType"],
  status: UsageQuotaProvider["status"],
): UsageQuotaProvider {
  return {
    providerId,
    label,
    accessType,
    status,
    confidence: "unknown",
    estimatedInputTokens: null,
    estimatedOutputTokens: null,
    estimatedTotalTokens: null,
    configuredLimitTokens: null,
    estimatedRemainingTokens: null,
    resetWindowLabel: null,
    recentLimitEvents: null,
    lastUpdated: null,
  };
}

function formatNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "Unknown";
}

function formatLimit(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "Not configured";
}

function statusLabel(status: UsageQuotaProvider["status"]) {
  if (status === "active") return "Active";
  if (status === "disabled") return "Disabled";
  return "Unknown";
}

function lastUpdatedLabel(value: string | null | undefined) {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function compactProviderLabel(provider: UsageQuotaProvider) {
  return provider.label.replace(/\s+subscription$/i, "").trim();
}

function hasNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function compactUsageLabel(provider: UsageQuotaProvider) {
  const label = compactProviderLabel(provider);
  if (hasNumber(provider.configuredLimitTokens) && provider.configuredLimitTokens > 0 && hasNumber(provider.estimatedTotalTokens)) {
    const remainingPercent = Math.max(
      0,
      Math.round(((provider.configuredLimitTokens - provider.estimatedTotalTokens) / provider.configuredLimitTokens) * 100),
    );
    return `${label} ~${remainingPercent}% left`;
  }
  if (hasNumber(provider.estimatedTotalTokens)) return `${label} tracked`;
  return `${label} unknown`;
}

export const UsageQuotasButton: FC<{ openAiApiEnabled?: boolean }> = ({ openAiApiEnabled = false }) => {
  const [open, setOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<UsageQuotasResponse | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    fetch("/api/usage/quotas", { signal: ac.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Usage request failed (${res.status})`);
        return (await res.json()) as UsageQuotasResponse;
      })
      .then(setData)
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Unable to load usage estimates");
      })
      .finally(() => setLoading(false));
    return () => ac.abort();
  }, []);

  const providers = useMemo(() => {
    const rows = data?.providers?.length ? data.providers : fallbackProviders;
    return rows.map((p) =>
      p.providerId === "openai" ? { ...p, status: openAiApiEnabled ? p.status : "disabled" as const } : p,
    );
  }, [data, openAiApiEnabled]);

  const compactProviders = useMemo(
    () => providers.filter((p) => p.accessType === "subscription" && (p.status === "active" || p.status === "unknown")),
    [providers],
  );
  const compactSummary = useMemo(() => {
    if (!compactProviders.length) return "Usage";
    const labels = compactProviders.map(compactUsageLabel);
    return `${labels.join(" · ")} · Usage`;
  }, [compactProviders]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-border/60 bg-muted/20 px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:bg-muted/40 hover:text-foreground sm:min-h-0"
        data-testid="usage-quotas-trigger"
        aria-label="Open usage and quotas overview"
      >
        <span className="max-w-[60vw] truncate">{compactSummary}</span>
        <ChevronDown className="size-3 opacity-70" />
      </button>

      {open ? (
        <div className="absolute left-0 top-full z-50 mt-1 w-[min(20rem,calc(100vw-2rem))] rounded-md border border-border bg-popover p-3 text-xs shadow-md">
          <div className="font-semibold text-popover-foreground">Usage / quotas</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            Estimated from local runs. Provider-side quotas may differ.
          </div>
          <div className="mt-3 space-y-2">
            {loading ? <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-3 animate-spin" /> Loading estimates…</div> : null}
            {error ? <div className="rounded border border-destructive/30 bg-destructive/10 p-2 text-destructive">{error}</div> : null}
            {providers.map((p) => <CompactProviderRow key={p.providerId} provider={p} />)}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3 w-full justify-center text-xs"
            onClick={() => {
              setPanelOpen(true);
              setOpen(false);
            }}
          >
            Open full usage dashboard
          </Button>
        </div>
      ) : null}

      <UsagePanel
        open={panelOpen}
        onOpenChange={setPanelOpen}
        providers={providers}
        recentRuns={data?.recentRuns ?? []}
        loading={loading}
        error={error}
      />
    </div>
  );
};

const CompactProviderRow: FC<{ provider: UsageQuotaProvider }> = ({ provider }) => (
  <div className="rounded-md border border-border/60 bg-background/60 p-2">
    <div className="flex items-center justify-between gap-2">
      <div className="font-medium text-foreground">{provider.label}</div>
      <div className={cn("rounded-full px-2 py-0.5 text-[10px]", provider.status === "active" ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground")}>{statusLabel(provider.status)}</div>
    </div>
    <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      <span>Used: {formatNumber(provider.estimatedTotalTokens)}</span>
      <span>Limit: {formatLimit(provider.configuredLimitTokens)}</span>
      <span>Remaining: {formatLimit(provider.estimatedRemainingTokens)}</span>
      <span>Reset: {provider.resetWindowLabel ?? "Unknown"}</span>
      <span>Events: {provider.recentLimitEvents ?? 0}</span>
      <span>Confidence: {provider.confidence}</span>
    </div>
    {provider.providerId === "openai" ? <div className="mt-1 text-[11px] text-muted-foreground">No fallback billing allowed.</div> : null}
  </div>
);

const UsagePanel: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: UsageQuotaProvider[];
  recentRuns: UsageQuotasResponse["recentRuns"];
  loading: boolean;
  error: string | null;
}> = ({ open, onOpenChange, providers, recentRuns, loading, error }) => (
  <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
      <DialogPrimitive.Content className="fixed inset-3 z-50 overflow-hidden rounded-xl border border-border bg-background shadow-xl outline-none sm:inset-6">
        <div className="flex h-full flex-col">
          <div className="flex items-start gap-3 border-b border-border/60 p-4">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="text-lg font-semibold">Estimated subscription usage</DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">
                Estimated from local execution logs. Exact provider quotas are shown only when a provider exposes them. No API billing fallback is used.
              </DialogPrimitive.Description>
            </div>
            <Button type="button" variant="ghost" size="icon" onClick={() => onOpenChange(false)} aria-label="Close usage panel"><X className="size-4" /></Button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {loading ? <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading estimates…</div> : null}
            {error ? <div className="mb-3 rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
            <div className="grid gap-3 md:grid-cols-3">
              {providers.map((p) => <CompactProviderRow key={p.providerId} provider={p} />)}
            </div>
            <div className="mt-5 overflow-x-auto rounded-md border border-border/60">
              <table className="w-full min-w-[900px] text-left text-xs">
                <thead className="bg-muted/30 text-muted-foreground"><tr>{["Provider","Access type","Estimated input tokens","Estimated output tokens","Estimated total","Configured limit","Estimated remaining","Reset window","Confidence","Last updated"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
                <tbody>
                  {providers.map((p) => <tr key={p.providerId} className="border-t border-border/60"><td className="px-3 py-2 font-medium">{p.label}</td><td className="px-3 py-2">{p.accessType}</td><td className="px-3 py-2">{formatNumber(p.estimatedInputTokens)}</td><td className="px-3 py-2">{formatNumber(p.estimatedOutputTokens)}</td><td className="px-3 py-2">{formatNumber(p.estimatedTotalTokens)}</td><td className="px-3 py-2">{formatLimit(p.configuredLimitTokens)}</td><td className="px-3 py-2">{formatLimit(p.estimatedRemainingTokens)}</td><td className="px-3 py-2">{p.resetWindowLabel ?? "Unknown"}</td><td className="px-3 py-2">{p.confidence}</td><td className="px-3 py-2">{lastUpdatedLabel(p.lastUpdated)}</td></tr>)}
                </tbody>
              </table>
            </div>
            <section className="mt-5 grid gap-4 md:grid-cols-2">
              <div className="rounded-md border border-border/60 p-3"><h3 className="font-medium">Recent usage/runs</h3>{recentRuns.length ? <ul className="mt-2 space-y-1 text-xs text-muted-foreground">{recentRuns.map((r, i) => <li key={`${r.providerId}-${r.at}-${i}`}>{r.label}: {formatNumber(r.totalTokens)} tokens · {lastUpdatedLabel(r.at)}</li>)}</ul> : <p className="mt-2 text-xs text-muted-foreground">No local data yet.</p>}</div>
              <div className="rounded-md border border-border/60 p-3"><h3 className="font-medium">Recent limit/rate-limit events</h3>{providers.some((p) => (p.recentLimitEvents ?? 0) > 0) ? <ul className="mt-2 space-y-1 text-xs text-muted-foreground">{providers.filter((p) => (p.recentLimitEvents ?? 0) > 0).map((p) => <li key={p.providerId}>{p.label}: {p.recentLimitEvents} recent event(s)</li>)}</ul> : <p className="mt-2 text-xs text-muted-foreground">No recent limit events in local logs.</p>}</div>
            </section>
            <div className="mt-5 rounded-md border border-border/60 bg-muted/20 p-3 text-sm text-muted-foreground">These numbers are estimates from local Control Room logs unless marked exact.</div>
          </div>
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>
);
