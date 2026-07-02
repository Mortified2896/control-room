"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ChevronDown, ImageUp, Loader2, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FC,
} from "react";
import type { ProviderUsageSnapshot } from "@/lib/usage/snapshot-shape";

export type UsageQuotaProvider = {
  providerId: string;
  label: string;
  accessType: "subscription" | "api" | "local" | "unknown";
  status: "active" | "disabled" | "unknown";
  confidence: "exact" | "observed" | "estimated" | "unknown";
  estimatedInputTokens?: number | null;
  estimatedOutputTokens?: number | null;
  estimatedTotalTokens?: number | null;
  configuredLimitTokens?: number | null;
  estimatedRemainingTokens?: number | null;
  resetWindowLabel?: string | null;
  recentLimitEvents?: number | null;
  lastUpdated?: string | null;

  /** Snapshot-derived fields, surfaced when a confirmed screenshot exists. */
  shortWindowLabel?: string | null;
  shortWindowUsedPercent?: number | null;
  shortWindowRemainingPercent?: number | null;
  shortWindowResetLabel?: string | null;
  weeklyWindowLabel?: string | null;
  weeklyWindowUsedPercent?: number | null;
  weeklyWindowRemainingPercent?: number | null;
  weeklyWindowResetLabel?: string | null;
  creditsRemaining?: number | null;
  planName?: string | null;
  last7DaysUsage?: string | null;
  last30DaysUsage?: string | null;
  usageAtTimestampValue?: string | null;
  usageAtTimestampLabel?: string | null;
  snapshotCapturedAt?: string | null;
  snapshotSourceType?: string | null;
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
    shortWindowLabel: null,
    shortWindowUsedPercent: null,
    shortWindowRemainingPercent: null,
    shortWindowResetLabel: null,
    weeklyWindowLabel: null,
    weeklyWindowUsedPercent: null,
    weeklyWindowRemainingPercent: null,
    weeklyWindowResetLabel: null,
    creditsRemaining: null,
    planName: null,
    last7DaysUsage: null,
    last30DaysUsage: null,
    usageAtTimestampValue: null,
    usageAtTimestampLabel: null,
    snapshotCapturedAt: null,
    snapshotSourceType: null,
  };
}

function formatNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "Unknown";
}

function formatLimit(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString()
    : "Not configured";
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

/**
 * Short-window display label. Prefers the user's snapshot-derived
 * label ("5h limit", "5 hour usage limit"); falls back to "5h" for
 * subscription providers that have not yet been confirmed.
 */
function shortWindowTag(provider: UsageQuotaProvider): string {
  const label = provider.shortWindowLabel;
  if (typeof label === "string" && label.trim() !== "") return label.trim();
  return provider.providerId === "codex" ? "5h" : "5h";
}

function weeklyWindowTag(provider: UsageQuotaProvider): string {
  const label = provider.weeklyWindowLabel;
  if (typeof label === "string" && label.trim() !== "") return label.trim();
  return "weekly";
}

function compactUsageLabel(provider: UsageQuotaProvider) {
  const label = compactProviderLabel(provider);
  const shortRemaining = provider.shortWindowRemainingPercent;
  const weeklyRemaining = provider.weeklyWindowRemainingPercent;
  // Compact within-provider format mirrors the spec example
  // `MiniMax 99%/19%`: tight percent-to-percent with no spaces. The
  // between-provider separator is the middot used by the rest of the
  // summary (`·`). Tags are only surfaced inside the full panel and
  // the popover rows.
  if (hasNumber(shortRemaining) || hasNumber(weeklyRemaining)) {
    const parts: string[] = [];
    if (hasNumber(shortRemaining)) parts.push(`${shortRemaining}%`);
    if (hasNumber(weeklyRemaining)) parts.push(`${weeklyRemaining}%`);
    return `${label} ${parts.join("/")}`;
  }
  // Fall through to the existing token-based estimate logic for
  // providers with no confirmed snapshot.
  if (
    hasNumber(provider.configuredLimitTokens) &&
    provider.configuredLimitTokens! > 0 &&
    hasNumber(provider.estimatedTotalTokens)
  ) {
    const remainingPercent = Math.max(
      0,
      Math.round(
        ((provider.configuredLimitTokens! - provider.estimatedTotalTokens!) /
          provider.configuredLimitTokens!) *
          100,
      ),
    );
    return `${label} ~${remainingPercent}% left`;
  }
  if (hasNumber(provider.estimatedTotalTokens)) return `${label} tracked`;
  return `${label} unknown`;
}

export const UsageQuotasButton: FC<{ openAiApiEnabled?: boolean }> = ({
  openAiApiEnabled = false,
}) => {
  const [open, setOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<UsageQuotasResponse | null>(null);
  /**
   * Increments after every successful confirm so the panel can refetch
   * `/api/usage/snapshots` and overlay the new values on the local
   * estimate. We re-fetch directly inside the panel; this trigger
   * just nudges it.
   */
  const [snapshotTick, setSnapshotTick] = useState(0);
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
  }, [snapshotTick]);

  const providers = useMemo(() => {
    const rows = data?.providers?.length ? data.providers : fallbackProviders;
    return rows.map((p) =>
      p.providerId === "openai"
        ? { ...p, status: openAiApiEnabled ? p.status : ("disabled" as const) }
        : p,
    );
  }, [data, openAiApiEnabled]);

  const compactProviders = useMemo(
    () =>
      providers.filter(
        (p) => p.accessType === "subscription" && (p.status === "active" || p.status === "unknown"),
      ),
    [providers],
  );
  const compactSummary = useMemo(() => {
    if (!compactProviders.length) return "Usage";
    const labels = compactProviders.map(compactUsageLabel);
    return `${labels.join(" · ")}`;
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
        <span className="max-w-[60vw] truncate" data-testid="usage-quotas-compact-summary">
          {compactSummary}
        </span>
        <ChevronDown className="size-3 opacity-70" />
      </button>

      {open ? (
        <div className="absolute left-0 top-full z-50 mt-1 w-[min(20rem,calc(100vw-2rem))] rounded-md border border-border bg-popover p-3 text-xs shadow-md">
          <div className="font-semibold text-popover-foreground">Usage / quotas</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            Estimated from local runs. Provider-side quotas may differ.
          </div>
          <div className="mt-3 space-y-2">
            {loading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-3 animate-spin" /> Loading estimates…
              </div>
            ) : null}
            {error ? (
              <div className="rounded border border-destructive/30 bg-destructive/10 p-2 text-destructive">
                {error}
              </div>
            ) : null}
            {providers.map((p) => (
              <CompactProviderRow key={p.providerId} provider={p} />
            ))}
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
        snapshotTick={snapshotTick}
        onSnapshotSaved={() => setSnapshotTick((t) => t + 1)}
      />
    </div>
  );
};

const CompactProviderRow: FC<{ provider: UsageQuotaProvider }> = ({ provider }) => (
  <div
    className="rounded-md border border-border/60 bg-background/60 p-2"
    data-testid={`usage-compact-row-${provider.providerId}`}
  >
    <div className="flex items-center justify-between gap-2">
      <div className="font-medium text-foreground">{provider.label}</div>
      <div
        className={cn(
          "rounded-full px-2 py-0.5 text-[10px]",
          provider.status === "active"
            ? "bg-emerald-500/10 text-emerald-600"
            : "bg-muted text-muted-foreground",
        )}
      >
        {statusLabel(provider.status)}
      </div>
    </div>
    <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      <span>Used: {formatNumber(provider.estimatedTotalTokens)}</span>
      <span>Limit: {formatLimit(provider.configuredLimitTokens)}</span>
      <span>Remaining: {formatLimit(provider.estimatedRemainingTokens)}</span>
      <span>Reset: {provider.resetWindowLabel ?? "Unknown"}</span>
      <span>Events: {provider.recentLimitEvents ?? 0}</span>
      <span>Confidence: {provider.confidence}</span>
    </div>
    {hasNumber(provider.shortWindowRemainingPercent) ||
    hasNumber(provider.weeklyWindowRemainingPercent) ? (
      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>
          {shortWindowTag(provider)} remaining:{" "}
          {hasNumber(provider.shortWindowRemainingPercent)
            ? `${provider.shortWindowRemainingPercent}%`
            : "Unknown"}
        </span>
        <span>
          {weeklyWindowTag(provider)} remaining:{" "}
          {hasNumber(provider.weeklyWindowRemainingPercent)
            ? `${provider.weeklyWindowRemainingPercent}%`
            : "Unknown"}
        </span>
      </div>
    ) : null}
    {provider.providerId === "openai" ? (
      <div className="mt-1 text-[11px] text-muted-foreground">No fallback billing allowed.</div>
    ) : null}
    {provider.snapshotCapturedAt ? (
      <div className="mt-1 text-[11px] text-muted-foreground">
        Source: {provider.snapshotSourceType ?? "screenshot"} · captured{" "}
        {relativeTimeLabel(provider.snapshotCapturedAt)}
      </div>
    ) : null}
  </div>
);

function relativeTimeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return "just now";
  if (diffMs < 60 * 60_000) return `${Math.round(diffMs / 60_000)}m ago`;
  if (diffMs < 24 * 60 * 60_000) return `${Math.round(diffMs / (60 * 60_000))}h ago`;
  return `${Math.round(diffMs / (24 * 60 * 60_000))}d ago`;
}

const UsagePanel: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: UsageQuotaProvider[];
  recentRuns: UsageQuotasResponse["recentRuns"];
  loading: boolean;
  error: string | null;
  snapshotTick: number;
  onSnapshotSaved: () => void;
}> = ({
  open,
  onOpenChange,
  providers,
  recentRuns,
  loading,
  error,
  snapshotTick,
  onSnapshotSaved,
}) => {
  const [snapshots, setSnapshots] = useState<Record<string, ProviderUsageSnapshot | null>>({});

  // Refetch latest snapshots whenever the panel opens or a new one is
  // confirmed. Uses tryDb-friendly endpoint so a missing DB just
  // returns `{}`.
  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    fetch("/api/usage/snapshots?limit=200", { signal: ac.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Snapshot fetch failed (${res.status})`);
        return (await res.json()) as { snapshots: ProviderUsageSnapshot[] };
      })
      .then((payload) => {
        const map: Record<string, ProviderUsageSnapshot | null> = {};
        for (const snap of payload.snapshots) {
          if (map[snap.providerId] === undefined) map[snap.providerId] = snap;
        }
        setSnapshots(map);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // Snapshots are overlay data; missing DB is non-fatal.
        setSnapshots({});
      });
    return () => ac.abort();
  }, [open, snapshotTick]);

  // Overlay the latest snapshot onto each provider row. Provider rows
  // from /api/usage/quotas already include snapshot-derived fields
  // (because the route joins on the latest snapshot), but we still
  // keep a snapshot map so the "Update from screenshot" section can
  // display the live `provider_usage_snapshots` row.
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <DialogPrimitive.Content className="fixed inset-3 z-50 overflow-hidden rounded-xl border border-border bg-background shadow-xl outline-none sm:inset-6">
          <div className="flex h-full flex-col">
            <div className="flex items-start gap-3 border-b border-border/60 p-4">
              <div className="min-w-0 flex-1">
                <DialogPrimitive.Title className="text-lg font-semibold">
                  Estimated subscription usage
                </DialogPrimitive.Title>
                <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">
                  Estimated from local execution logs. Exact provider quotas are shown only when a
                  provider exposes them. No API billing fallback is used.
                </DialogPrimitive.Description>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => onOpenChange(false)}
                aria-label="Close usage panel"
              >
                <X className="size-4" />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {loading ? (
                <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Loading estimates…
                </div>
              ) : null}
              {error ? (
                <div className="mb-3 rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              ) : null}
              <div className="grid gap-3 md:grid-cols-3">
                {providers.map((p) => (
                  <CompactProviderRow key={p.providerId} provider={p} />
                ))}
              </div>
              <div className="mt-5 overflow-x-auto rounded-md border border-border/60">
                <table className="w-full min-w-[1000px] text-left text-xs">
                  <thead className="bg-muted/30 text-muted-foreground">
                    <tr>
                      {[
                        "Provider",
                        "Access type",
                        "Estimated input",
                        "Estimated output",
                        "Estimated total",
                        "Configured limit",
                        "Estimated remaining",
                        "Reset window",
                        "Confidence",
                        "Last updated",
                      ].map((h) => (
                        <th key={h} className="px-3 py-2 font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {providers.map((p) => (
                      <tr key={p.providerId} className="border-t border-border/60">
                        <td className="px-3 py-2 font-medium">{p.label}</td>
                        <td className="px-3 py-2">{p.accessType}</td>
                        <td className="px-3 py-2">{formatNumber(p.estimatedInputTokens)}</td>
                        <td className="px-3 py-2">{formatNumber(p.estimatedOutputTokens)}</td>
                        <td className="px-3 py-2">{formatNumber(p.estimatedTotalTokens)}</td>
                        <td className="px-3 py-2">{formatLimit(p.configuredLimitTokens)}</td>
                        <td className="px-3 py-2">{formatLimit(p.estimatedRemainingTokens)}</td>
                        <td className="px-3 py-2">{p.resetWindowLabel ?? "Unknown"}</td>
                        <td className="px-3 py-2">{p.confidence}</td>
                        <td className="px-3 py-2">{lastUpdatedLabel(p.lastUpdated)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <section className="mt-5 grid gap-4 md:grid-cols-2">
                <div className="rounded-md border border-border/60 p-3">
                  <h3 className="font-medium">Recent usage/runs</h3>
                  {recentRuns.length ? (
                    <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                      {recentRuns.map((r, i) => (
                        <li key={`${r.providerId}-${r.at}-${i}`}>
                          {r.label}: {formatNumber(r.totalTokens)} tokens · {lastUpdatedLabel(r.at)}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">No local data yet.</p>
                  )}
                </div>
                <div className="rounded-md border border-border/60 p-3">
                  <h3 className="font-medium">Recent limit/rate-limit events</h3>
                  {providers.some((p) => (p.recentLimitEvents ?? 0) > 0) ? (
                    <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                      {providers
                        .filter((p) => (p.recentLimitEvents ?? 0) > 0)
                        .map((p) => (
                          <li key={p.providerId}>
                            {p.label}: {p.recentLimitEvents} recent event(s)
                          </li>
                        ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">
                      No recent limit events in local logs.
                    </p>
                  )}
                </div>
              </section>
              <ScreenshotUpdateSection
                providers={providers}
                snapshots={snapshots}
                onSnapshotSaved={onSnapshotSaved}
              />
              <div className="mt-5 rounded-md border border-border/60 bg-muted/20 p-3 text-sm text-muted-foreground">
                These numbers are estimates from local Control Room logs unless marked exact.
              </div>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
};

// ---------------------------------------------------------------------------
// Update from screenshot section
// ---------------------------------------------------------------------------

type ExtractResponse = {
  extractionMode: "manual_placeholder";
  detectedProvider: "minimax" | "codex" | "unknown";
  providerConfidence: "high" | "low" | "none";
  matchedLabels: string[];
  requiresUserConfirmation: true;
  candidate: ProviderUsageSnapshot;
};

type ProviderOption = "minimax" | "codex" | "auto";

type FlowState =
  | { kind: "idle" }
  | { kind: "extracting"; fileName: string; file: File }
  | {
      kind: "reviewing";
      fileName: string;
      file: File;
      candidate: ProviderUsageSnapshot;
      detectedProvider: "minimax" | "codex" | "unknown";
      providerConfidence: "high" | "low" | "none";
      matchedLabels: string[];
      providerChoice: ProviderOption;
    }
  | { kind: "persisting"; candidate: ProviderUsageSnapshot }
  | { kind: "confirmed"; snapshot: ProviderUsageSnapshot }
  | { kind: "error"; message: string; phase: "extract" | "persist" };

/**
 * The exact analysis method exposed to the UI. Hard rule: there is no
 * LLM and no provider API call. The screenshot is matched against a
 * fixed label list and the percent fields are derived with a closed-
 * form math step. The "prompt" surfaced to the user is therefore a
 * declarative description of that local pipeline, not a model prompt.
 */
const ANALYSIS_METHOD = {
  pipeline: "local heuristic only",
  llm: "none",
  ocr: "none",
  providerApiCalls: "none",
  openaiBilling: "none",
  providerLogin: "never",
  // Detection labels — these are the substrings matched against the
  // uploaded filename (and the first 64 KB of bytes, treated as text)
  // by `lib/usage/screenshot-parser.ts:detectProviderFromLabels`.
  minimaxLabels: [
    "Plan Usage",
    "MiniMax Subscription Plan Usage Details",
    "Token Plan",
    "Monthly Plus",
    "5h limit",
    "Weekly limit",
  ],
  codexLabels: [
    "Balance",
    "Codex usage draws from your shared agentic usage limit",
    "5 hour usage limit",
    "Weekly usage limit",
    "Credits remaining",
  ],
  // Percent normalization rules. The user is the source of truth;
  // these rules only run when the user did NOT supply the matching
  // percent explicitly.
  minimaxNormalization:
    "MiniMax screenshot shows USED %. We derive remaining = 100 - used (clamped to 0..100).",
  codexNormalization:
    "Codex screenshot shows REMAINING %. We derive used = 100 - remaining (clamped to 0..100).",
} as const;

const ScreenshotUpdateSection: FC<{
  providers: UsageQuotaProvider[];
  snapshots: Record<string, ProviderUsageSnapshot | null>;
  onSnapshotSaved: () => void;
}> = ({ providers, snapshots, onSnapshotSaved }) => {
  const [flow, setFlow] = useState<FlowState>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setFlow({ kind: "idle" });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const submitFile = useCallback(async (file: File, explicitProvider: ProviderOption) => {
    setFlow({ kind: "extracting", fileName: file.name, file });
    try {
      const fd = new FormData();
      fd.set("file", file);
      if (explicitProvider !== "auto") fd.set("providerId", explicitProvider);

      const res = await fetch("/api/usage/screenshot/extract", {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Extract failed (${res.status})`);
      }
      const payload = (await res.json()) as ExtractResponse;
      setFlow({
        kind: "reviewing",
        fileName: file.name,
        file,
        candidate: payload.candidate,
        detectedProvider: payload.detectedProvider,
        providerConfidence: payload.providerConfidence,
        matchedLabels: payload.matchedLabels,
        providerChoice: explicitProvider,
      });
    } catch (err) {
      setFlow({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to extract screenshot.",
        phase: "extract",
      });
    }
  }, []);

  const handleFile = useCallback(
    (file: File | null) => {
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        setFlow({ kind: "error", message: "Only image files are supported.", phase: "extract" });
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        setFlow({ kind: "error", message: "Image exceeds the 8 MB cap.", phase: "extract" });
        return;
      }
      void submitFile(file, "auto");
    },
    [submitFile],
  );

  const handleInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0] ?? null;
      handleFile(file);
    },
    [handleFile],
  );

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files?.[0] ?? null;
      handleFile(file);
    },
    [handleFile],
  );

  const onConfirm = useCallback(async () => {
    if (flow.kind !== "reviewing") return;
    const base: ProviderUsageSnapshot = {
      ...flow.candidate,
      // When the user explicitly chose a provider, prefer it over the
      // heuristic. The endpoint already does this, but we re-apply
      // here so the request matches the form's selected choice.
      ...(flow.providerChoice !== "auto"
        ? {
            providerId: flow.providerChoice,
            providerLabel:
              flow.providerChoice === "minimax" ? "MiniMax subscription" : "Codex subscription",
            accessType: "subscription" as const,
          }
        : {}),
    };
    // The write schema strips `id`/`createdAt`/`updatedAt`/`capturedAt`
    // server-side, so we DO NOT include them in the request body.
    // (Setting them to null here would be ignored by the route, but
    // omitting them keeps the JSON clean.)
    const payload: Omit<ProviderUsageSnapshot, "id" | "createdAt" | "updatedAt" | "capturedAt"> = {
      providerId: base.providerId,
      providerLabel: base.providerLabel,
      accessType: base.accessType,
      sourceType: base.sourceType,
      confidence: base.confidence,
      planName: base.planName,
      shortWindowLabel: base.shortWindowLabel,
      shortWindowUsedPercent: base.shortWindowUsedPercent,
      shortWindowRemainingPercent: base.shortWindowRemainingPercent,
      shortWindowResetLabel: base.shortWindowResetLabel,
      weeklyWindowLabel: base.weeklyWindowLabel,
      weeklyWindowUsedPercent: base.weeklyWindowUsedPercent,
      weeklyWindowRemainingPercent: base.weeklyWindowRemainingPercent,
      weeklyWindowResetLabel: base.weeklyWindowResetLabel,
      creditsRemaining: base.creditsRemaining,
      usageAtTimestampValue: base.usageAtTimestampValue,
      usageAtTimestampLabel: base.usageAtTimestampLabel,
      last7DaysUsage: base.last7DaysUsage,
      last30DaysUsage: base.last30DaysUsage,
      estimatedInputTokens: base.estimatedInputTokens,
      estimatedOutputTokens: base.estimatedOutputTokens,
      estimatedTotalTokens: base.estimatedTotalTokens,
      configuredLimitTokens: base.configuredLimitTokens,
      estimatedRemainingTokens: base.estimatedRemainingTokens,
      notes: base.notes,
      screenshotAttachmentId: base.screenshotAttachmentId,
    };
    setFlow({
      kind: "persisting",
      candidate: { ...base, id: null, capturedAt: new Date().toISOString() },
    });
    try {
      const res = await fetch("/api/usage/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshot: payload }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Save failed (${res.status})`);
      }
      const { snapshot } = (await res.json()) as { snapshot: ProviderUsageSnapshot };
      setFlow({ kind: "confirmed", snapshot });
      onSnapshotSaved();
    } catch (err) {
      setFlow({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to save snapshot.",
        phase: "persist",
      });
    }
  }, [flow, onSnapshotSaved]);

  const subscriptionProviders = providers.filter((p) => p.accessType === "subscription");
  const capturedSnapshots = subscriptionProviders
    .map((p) => snapshots[p.providerId])
    .filter((s): s is ProviderUsageSnapshot => Boolean(s));

  return (
    <section
      className="mt-5 rounded-md border border-border/60 bg-background/60 p-4"
      data-testid="usage-screenshot-section"
      aria-labelledby="usage-screenshot-section-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="usage-screenshot-section-title" className="text-sm font-semibold">
            Update from screenshot
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Drop a MiniMax or Codex usage screenshot. Control Room will extract visible usage
            values, then you can confirm before saving.
          </p>
        </div>
        {capturedSnapshots.length > 0 ? (
          <div className="text-[11px] text-muted-foreground" data-testid="usage-snapshot-source">
            {capturedSnapshots.map((s) => (
              <div key={s.id ?? `${s.providerId}-${s.capturedAt}`}>
                {s.providerLabel}: source {s.sourceType ?? "screenshot"}, captured{" "}
                {relativeTimeLabel(s.capturedAt)}, confidence {s.confidence}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {flow.kind === "idle" || flow.kind === "error" ? (
        <div className="mt-3 space-y-3">
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click();
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-border/60 bg-muted/10 px-4 py-8 text-center text-xs text-muted-foreground transition-colors hover:bg-muted/30",
              dragging && "border-primary/60 bg-primary/5",
            )}
            data-testid="usage-screenshot-dropzone"
            aria-label="Drop or click to upload a usage screenshot"
          >
            <ImageUp className="size-5 opacity-70" />
            <span>Drop a MiniMax or Codex usage screenshot here</span>
            <span className="text-[11px] opacity-70">
              PNG, JPG, or WEBP up to 8 MB. Nothing is saved until you confirm.
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleInputChange}
              className="hidden"
              data-testid="usage-screenshot-file-input"
              aria-label="Choose a usage screenshot"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <label
              htmlFor="usage-screenshot-provider-select"
              className="font-medium text-foreground"
            >
              Provider override
            </label>
            <select
              id="usage-screenshot-provider-select"
              defaultValue="auto"
              data-testid="usage-screenshot-provider-select"
              className="rounded-md border border-border/60 bg-background px-2 py-1 text-xs"
              onChange={(e) => {
                const choice = e.target.value as ProviderOption;
                if (choice === "auto") return;
                // Pre-populate the next drop with an explicit provider
                // hint by stashing it on the file input via a dataset.
                if (fileInputRef.current) fileInputRef.current.dataset.provider = choice;
              }}
            >
              <option value="auto">Auto-detect from filename / labels</option>
              <option value="minimax">MiniMax</option>
              <option value="codex">Codex</option>
            </select>
            <span className="opacity-80">
              Heuristics only — Control Room never logs into MiniMax or Codex websites. Use the
              manual fields below if a label is missing.
            </span>
          </div>
          {flow.kind === "error" ? (
            <div
              className="rounded border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive"
              role="alert"
            >
              {flow.message}
              <Button type="button" variant="ghost" size="xs" className="ml-2" onClick={reset}>
                Dismiss
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {flow.kind === "extracting" ? (
        <div
          className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"
          data-testid="usage-screenshot-extracting"
        >
          <Loader2 className="size-4 animate-spin" /> Extracting values from {flow.fileName}…
        </div>
      ) : null}

      {flow.kind === "reviewing" || flow.kind === "persisting" || flow.kind === "confirmed" ? (
        <ReviewForm
          flow={flow}
          file={flow.kind === "reviewing" ? flow.file : null}
          onChange={(next) => setFlow(next)}
          onConfirm={onConfirm}
          onCancel={reset}
        />
      ) : null}
    </section>
  );
};

const ReviewForm: FC<{
  flow:
    | ExtractFlowReviewing
    | { kind: "persisting"; candidate: ProviderUsageSnapshot }
    | { kind: "confirmed"; snapshot: ProviderUsageSnapshot };
  /** The original uploaded screenshot, kept so the user can review
   *  the image while editing the form. Optional so the parent can
   *  reuse the same component for persisting/confirmed states where
   *  the file has been discarded. */
  file: File | null;
  onChange: (next: FlowState) => void;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ flow, file, onChange, onConfirm, onCancel }) => {
  if (flow.kind !== "reviewing" && flow.kind !== "persisting" && flow.kind !== "confirmed") {
    return null;
  }
  const candidate: ProviderUsageSnapshot =
    flow.kind === "confirmed" ? flow.snapshot : flow.candidate;
  const busy = flow.kind === "persisting";

  const setField = <K extends keyof ProviderUsageSnapshot>(
    key: K,
    value: ProviderUsageSnapshot[K],
  ) => {
    if (flow.kind !== "reviewing") return;
    onChange({ ...flow, candidate: { ...flow.candidate, [key]: value } });
  };

  const setProviderChoice = (choice: ProviderOption) => {
    if (flow.kind !== "reviewing") return;
    const providerId = choice === "auto" ? flow.detectedProvider : choice;
    const providerLabel =
      providerId === "minimax"
        ? "MiniMax subscription"
        : providerId === "codex"
          ? "Codex subscription"
          : "Provider";
    onChange({
      ...flow,
      providerChoice: choice,
      candidate: {
        ...flow.candidate,
        providerId: providerId === "unknown" ? flow.candidate.providerId : providerId,
        providerLabel,
      },
    });
  };

  const providerId = candidate.providerId;
  const isCodex = providerId === "codex";
  const isMiniMax = providerId === "minimax";

  return (
    <div
      className="mt-3 space-y-3 rounded-md border border-border/60 bg-background p-3"
      data-testid="usage-screenshot-review-form"
    >
      <ScreenshotPreview file={file} />
      <AnalysisMethodDisclosure providerId={providerId} />
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <div>
          Detected provider:{" "}
          <span className="font-medium text-foreground">
            {flow.kind === "reviewing" ? flow.detectedProvider : candidate.providerId}
          </span>{" "}
          · confidence:{" "}
          <span className="font-medium text-foreground">
            {flow.kind === "reviewing" ? flow.providerConfidence : candidate.confidence}
          </span>
          {flow.kind === "reviewing" && flow.matchedLabels.length > 0 ? (
            <span> · matched: {flow.matchedLabels.join(", ")}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="usage-screenshot-form-provider" className="font-medium text-foreground">
            Provider
          </label>
          <select
            id="usage-screenshot-form-provider"
            value={flow.kind === "reviewing" ? flow.providerChoice : providerId}
            onChange={(e) => setProviderChoice(e.target.value as ProviderOption)}
            disabled={busy}
            className="rounded-md border border-border/60 bg-background px-2 py-1 text-xs"
            data-testid="usage-screenshot-form-provider"
          >
            <option value="auto">
              Auto ({flow.kind === "reviewing" ? flow.detectedProvider : providerId})
            </option>
            <option value="minimax">MiniMax</option>
            <option value="codex">Codex</option>
          </select>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {isMiniMax ? (
          <PercentField
            label="5h used %"
            hint="MiniMax screenshot shows the used percentage."
            value={candidate.shortWindowUsedPercent}
            onChange={(v) => setField("shortWindowUsedPercent", v)}
            disabled={busy}
            testId="usage-screenshot-short-window-used"
          />
        ) : null}
        <PercentField
          label={isCodex ? "5h remaining %" : "5h remaining % (derived)"}
          hint={
            isCodex
              ? "Codex screenshot shows the remaining percentage."
              : "Derived from used; edit to override."
          }
          value={candidate.shortWindowRemainingPercent}
          onChange={(v) => setField("shortWindowRemainingPercent", v)}
          disabled={busy}
          testId="usage-screenshot-short-window-remaining"
        />
        <TextField
          label="5h label"
          value={candidate.shortWindowLabel}
          onChange={(v) => setField("shortWindowLabel", v)}
          disabled={busy}
          placeholder="5h limit"
          testId="usage-screenshot-short-window-label"
        />
        <TextField
          label="5h reset"
          value={candidate.shortWindowResetLabel}
          onChange={(v) => setField("shortWindowResetLabel", v)}
          disabled={busy}
          placeholder="resets in 4 hr 44 min"
          testId="usage-screenshot-short-window-reset"
        />

        {isMiniMax ? (
          <PercentField
            label="Weekly used %"
            hint="MiniMax screenshot shows the used percentage."
            value={candidate.weeklyWindowUsedPercent}
            onChange={(v) => setField("weeklyWindowUsedPercent", v)}
            disabled={busy}
            testId="usage-screenshot-weekly-used"
          />
        ) : null}
        <PercentField
          label={isCodex ? "Weekly remaining %" : "Weekly remaining % (derived)"}
          hint={
            isCodex
              ? "Codex screenshot shows the remaining percentage."
              : "Derived from used; edit to override."
          }
          value={candidate.weeklyWindowRemainingPercent}
          onChange={(v) => setField("weeklyWindowRemainingPercent", v)}
          disabled={busy}
          testId="usage-screenshot-weekly-remaining"
        />
        <TextField
          label="Weekly label"
          value={candidate.weeklyWindowLabel}
          onChange={(v) => setField("weeklyWindowLabel", v)}
          disabled={busy}
          placeholder="Weekly limit"
          testId="usage-screenshot-weekly-label"
        />
        <TextField
          label="Weekly reset"
          value={candidate.weeklyWindowResetLabel}
          onChange={(v) => setField("weeklyWindowResetLabel", v)}
          disabled={busy}
          placeholder="resets in 3 days 8 hr"
          testId="usage-screenshot-weekly-reset"
        />

        <TextField
          label="Plan name"
          value={candidate.planName}
          onChange={(v) => setField("planName", v)}
          disabled={busy}
          placeholder="Token Plan · Monthly Plus"
          testId="usage-screenshot-plan"
        />
        <PercentField
          label="Credits remaining"
          hint="MiniMax/Codex credits tile; leave blank if not visible."
          value={candidate.creditsRemaining}
          onChange={(v) => setField("creditsRemaining", v)}
          disabled={busy}
          testId="usage-screenshot-credits"
          integer
        />
        <TextField
          label="Last 7 days usage"
          value={candidate.last7DaysUsage}
          onChange={(v) => setField("last7DaysUsage", v)}
          disabled={busy}
          placeholder="1.61B"
          testId="usage-screenshot-last-7-days"
        />
        <TextField
          label="Last 30 days usage"
          value={candidate.last30DaysUsage}
          onChange={(v) => setField("last30DaysUsage", v)}
          disabled={busy}
          placeholder="3.31B"
          testId="usage-screenshot-last-30-days"
        />
        <TextField
          label="Usage at timestamp"
          value={candidate.usageAtTimestampValue}
          onChange={(v) => setField("usageAtTimestampValue", v)}
          disabled={busy}
          placeholder="158.09M"
          testId="usage-screenshot-usage-value"
        />
        <TextField
          label="Usage timestamp label"
          value={candidate.usageAtTimestampLabel}
          onChange={(v) => setField("usageAtTimestampLabel", v)}
          disabled={busy}
          placeholder="02 Jul 15:00 UTC"
          testId="usage-screenshot-usage-label"
        />
        <TextField
          label="Notes"
          value={candidate.notes}
          onChange={(v) => setField("notes", v)}
          disabled={busy}
          placeholder="captured manually"
          testId="usage-screenshot-notes"
          wide
        />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onCancel}
          disabled={busy}
          data-testid="usage-screenshot-cancel"
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={onConfirm}
          disabled={busy || flow.kind === "confirmed"}
          data-testid="usage-screenshot-confirm"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : null}
          {flow.kind === "confirmed" ? "Saved" : "Confirm snapshot"}
        </Button>
      </div>

      {flow.kind === "confirmed" ? (
        <div
          className="rounded border border-emerald-500/30 bg-emerald-500/10 p-2 text-xs text-emerald-700 dark:text-emerald-300"
          role="status"
        >
          Snapshot saved at {lastUpdatedLabel(flow.snapshot.capturedAt)}. The provider display now
          reflects the confirmed values.
        </div>
      ) : null}
    </div>
  );
};

type ExtractFlowReviewing = Extract<FlowState, { kind: "reviewing" }>;

const PercentField: FC<{
  label: string;
  hint?: string;
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  disabled?: boolean;
  testId: string;
  integer?: boolean;
}> = ({ label, hint, value, onChange, disabled, testId, integer }) => {
  const display = value === null || value === undefined ? "" : String(value);
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="font-medium text-foreground">{label}</span>
      {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      <input
        type="number"
        inputMode={integer ? "numeric" : "decimal"}
        min={0}
        max={100}
        step={1}
        value={display}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") {
            onChange(null);
            return;
          }
          const parsed = Number(raw);
          if (!Number.isFinite(parsed)) {
            onChange(null);
            return;
          }
          onChange(parsed);
        }}
        disabled={disabled}
        data-testid={testId}
        className="h-8 rounded-md border border-border/60 bg-background px-2 text-xs"
        placeholder="0"
      />
    </label>
  );
};

const TextField: FC<{
  label: string;
  value: string | null | undefined;
  onChange: (v: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
  testId: string;
  wide?: boolean;
}> = ({ label, value, onChange, disabled, placeholder, testId, wide }) => {
  const display = value ?? "";
  return (
    <label className={cn("flex flex-col gap-1 text-xs", wide && "md:col-span-2")}>
      <span className="font-medium text-foreground">{label}</span>
      <input
        type="text"
        value={display}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        data-testid={testId}
        className="h-8 rounded-md border border-border/60 bg-background px-2 text-xs"
      />
    </label>
  );
};

/**
 * Renders the uploaded screenshot so the user can verify the values
 * they type against the image. Uses an object URL bound to the
 * component lifecycle; revoked on unmount or when the file changes
 * to avoid leaking the underlying blob.
 */
const ScreenshotPreview: FC<{ file: File | null }> = ({ file }) => {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  if (!file) return null;

  return (
    <div
      className="rounded-md border border-border/60 bg-muted/20 p-2"
      data-testid="usage-screenshot-preview"
    >
      <div className="mb-2 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          Screenshot preview: <span className="font-mono text-foreground">{file.name}</span>
          {" \u00b7 "}
          {Math.round(file.size / 1024)} KB
        </span>
        <span className="opacity-80">
          Image stays in your browser. Nothing is uploaded until you Confirm.
        </span>
      </div>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="block max-h-72 overflow-auto rounded border border-border/40 bg-background"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={`Uploaded ${file.name}`}
            className="mx-auto block max-h-72 w-auto object-contain"
          />
        </a>
      ) : null}
    </div>
  );
};

/**
 * Transparent "what's analyzing this image" disclosure. The hard
 * rule is that NOTHING is analyzed by a model: the screenshot bytes
 * are matched against a fixed label list, then the percent fields
 * are derived with a closed-form math step. The "prompt" surfaced
 * here is therefore a declarative description of the local
 * pipeline, not a model prompt.
 */
const AnalysisMethodDisclosure: FC<{ providerId: string }> = ({ providerId }) => {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="rounded-md border border-border/60 bg-muted/20 p-2 text-[11px] text-muted-foreground"
      data-testid="usage-screenshot-analysis-method"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer select-none font-medium text-foreground">
        How is this screenshot analyzed? (no LLM, no OCR, no API)
      </summary>
      <div className="mt-2 space-y-2">
        <p>
          The screenshot is matched against a fixed label list locally.{" "}
          <strong>No model is invoked.</strong> <strong>No OCR is run.</strong> Control Room never
          logs into MiniMax/Codex websites and never calls their APIs. No OpenAI / Anthropic /
          MiniMax / Codex endpoint is billed for this. Your subscription plan is the only thing
          exercising provider usage.
        </p>
        <div className="grid gap-2 md:grid-cols-2">
          <div className="rounded border border-border/40 bg-background/60 p-2">
            <div className="font-semibold text-foreground">Pipeline</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>
                Method: <span className="font-mono">{ANALYSIS_METHOD.pipeline}</span>
              </li>
              <li>
                LLM called: <span className="font-mono">{ANALYSIS_METHOD.llm}</span>
              </li>
              <li>
                OCR engine: <span className="font-mono">{ANALYSIS_METHOD.ocr}</span>
              </li>
              <li>
                Provider API calls:{" "}
                <span className="font-mono">{ANALYSIS_METHOD.providerApiCalls}</span>
              </li>
              <li>
                OpenAI billing: <span className="font-mono">{ANALYSIS_METHOD.openaiBilling}</span>
              </li>
              <li>
                Provider login: <span className="font-mono">{ANALYSIS_METHOD.providerLogin}</span>
              </li>
            </ul>
          </div>
          <div className="rounded border border-border/40 bg-background/60 p-2">
            <div className="font-semibold text-foreground">Detector labels (substring match)</div>
            <p className="mt-1">
              MiniMax (matched against the filename + the first 64 KB of bytes):
            </p>
            <ul className="mt-0.5 list-disc space-y-0.5 pl-4 font-mono text-[10px]">
              {ANALYSIS_METHOD.minimaxLabels.map((l) => (
                <li key={`minimax-${l}`}>{l}</li>
              ))}
            </ul>
            <p className="mt-1">Codex:</p>
            <ul className="mt-0.5 list-disc space-y-0.5 pl-4 font-mono text-[10px]">
              {ANALYSIS_METHOD.codexLabels.map((l) => (
                <li key={`codex-${l}`}>{l}</li>
              ))}
            </ul>
          </div>
        </div>
        <div className="rounded border border-border/40 bg-background/60 p-2">
          <div className="font-semibold text-foreground">Percent normalization</div>
          {providerId === "minimax" ? (
            <p className="mt-1">{ANALYSIS_METHOD.minimaxNormalization}</p>
          ) : (
            <p className="mt-1">{ANALYSIS_METHOD.codexNormalization}</p>
          )}
          <p className="mt-1 opacity-80">
            You are the source of truth: any field you edit is stored as-is, and the derived value
            is recomputed only when the source field is empty.
          </p>
        </div>
        <div className="rounded border border-border/40 bg-background/60 p-2">
          <div className="font-semibold text-foreground">Server endpoint</div>
          <p className="mt-1">
            <code className="font-mono text-[10px]">POST /api/usage/screenshot/extract</code>{" "}
            returns{" "}
            <code className="font-mono text-[10px]">extractionMode: "manual_placeholder"</code> and{" "}
            <code className="font-mono text-[10px]">requiresUserConfirmation: true</code>. The body
            is the full <code className="font-mono text-[10px]">ProviderUsageSnapshot</code> with
            all fields defaulted to <code className="font-mono text-[10px]">null</code> except
            providerId/providerLabel filled from the heuristic. Nothing is persisted server-side at
            this point.
          </p>
        </div>
      </div>
    </details>
  );
};
