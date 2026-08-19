"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Coins,
  Clock,
  Database,
  ExternalLink,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type {
  MiniMaxUsageWindow,
  SubscriptionUsageStatus,
} from "@/lib/minimax/subscription-usage";

type RouteResponse = {
  statuses: SubscriptionUsageStatus[];
};

function pct(value: number | undefined | null): string {
  if (value == null) return "—";
  return `${Math.round(value)}%`;
}

function getUsageColor(usedPercent: number): string {
  if (usedPercent >= 90) return "#ef4444";
  if (usedPercent >= 70) return "#f59e0b";
  return "#22c55e";
}

function formatCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

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

function userFacingError(error: NonNullable<SubscriptionUsageStatus["error"]>): {
  title: string;
  message: string;
} {
  const code = error.code;
  if (code === "missing_minimax_subscription_key") {
    return {
      title: "MiniMax subscription key missing",
      message:
        "Set MINIMAX_SUBSCRIPTION_KEY, or legacy MINIMAX_API_KEY if that contains the Token Plan subscription key.",
    };
  }
  if (code === "minimax_legacy_key_rejected") {
    return {
      title: "MiniMax legacy key rejected",
      message:
        "MiniMax rejected the configured key for the Token Plan endpoint. Use the Token Plan Subscription Key.",
    };
  }
  return { title: code, message: error.message };
}

function QuotaRow({ w }: { w: MiniMaxUsageWindow }) {
  const barColor = getUsageColor(w.usedPercent);
  return (
    <div className="flex items-center gap-3">
      <div className="w-28 shrink-0">
        <div className="text-sm font-medium">{w.label}</div>
        {w.resetInLabel ? (
          <div className="text-[10px] leading-tight text-muted-foreground">
            <Clock className="mr-0.5 inline size-2.5" />
            resets {w.resetInLabel}
          </div>
        ) : null}
      </div>
      <div className="flex-1">
        <div className="h-3 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${Math.max(w.usedPercent, 1)}%`,
              backgroundColor: barColor,
            }}
          />
        </div>
      </div>
      <div className="w-24 text-right">
        <div className="text-xs text-muted-foreground">Total quota 100%</div>
        <div className="text-sm font-semibold" style={{ color: barColor }}>
          Used {pct(w.usedPercent)}
        </div>
      </div>
    </div>
  );
}

function WindowsSection({ windows }: { windows: MiniMaxUsageWindow[] }) {
  if (windows.length === 0) return null;
  return (
    <div className="mt-4 space-y-3">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
        <BarChart3 className="size-3.5" />
        Token Plan Quota
      </h3>
      <div className="rounded-md border border-border/60 bg-muted/30 p-3">
        <div className="space-y-3">
          {windows.map((w) => (
            <QuotaRow key={w.windowType} w={w} />
          ))}
        </div>
      </div>
    </div>
  );
}

function DashboardOnlySection({
  icon,
  title,
  description,
  href,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  href: string;
}) {
  return (
    <div className="mt-3 rounded-md border border-border/40 bg-muted/10 p-3">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 shrink-0 text-muted-foreground">{icon}</div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground">{title}</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            {description}
          </p>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
          >
            Open MiniMax dashboard
            <ExternalLink className="size-3" />
          </a>
        </div>
      </div>
    </div>
  );
}

function SummaryGrid({
  summary,
}: {
  summary: NonNullable<SubscriptionUsageStatus["summary"]>;
}) {
  return (
    <div className="space-y-3">
      {summary.map((item, i) => (
        <div
          key={`${item.label}-${item.window}-${i}`}
          className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs"
        >
          <div className="flex items-center justify-between">
            <span className="font-medium">{item.label}</span>
            {item.window === "not_in_plan" ? (
              <span className="rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                not in plan
              </span>
            ) : item.window === "rolling_interval" ? (
              <span className="rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                rolling interval
              </span>
            ) : item.window === "weekly" ? (
              <span className="rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                weekly
              </span>
            ) : null}
          </div>
          {item.window !== "not_in_plan" ? (
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
              {item.limit != null ? (
                <>
                  <span>Limit</span>
                  <span className="text-right font-mono">
                    {item.limit.toLocaleString()}
                  </span>
                </>
              ) : null}
              {item.used != null ? (
                <>
                  <span>Used</span>
                  <span className="text-right font-mono">
                    {item.used.toLocaleString()}
                  </span>
                </>
              ) : null}
              {item.remaining != null ? (
                <>
                  <span>Remaining</span>
                  <span className="text-right font-mono">
                    {item.remaining.toLocaleString()}
                  </span>
                </>
              ) : null}
              {item.remainingPercent != null ? (
                <>
                  <span>Remaining %</span>
                  <span className="text-right font-mono">{pct(item.remainingPercent)}</span>
                </>
              ) : null}
              {item.resetAt ? (
                <>
                  <span>Resets</span>
                  <span className="text-right font-mono">
                    {new Date(item.resetAt).toLocaleString()}
                  </span>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function CardPill({ status }: { status: SubscriptionUsageStatus }) {
  if (status.ok) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
          status.rawAvailable
            ? "bg-emerald-500/10 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300"
            : "bg-muted text-muted-foreground ring-border",
        )}
      >
        {status.rawAvailable ? (
          <CheckCircle2 className="size-3.5" />
        ) : (
          <XCircle className="size-3.5" />
        )}
        {status.rawAvailable ? "Available" : "No quota"}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-500/30 dark:text-amber-300">
      <AlertTriangle className="size-3.5" />
      Unavailable
    </span>
  );
}

function LoadingPill() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground ring-1 ring-inset ring-border">
      <Loader2 className="size-3.5 animate-spin" />
      Checking…
    </span>
  );
}

function ErrorBlock({ error }: { error: NonNullable<SubscriptionUsageStatus["error"]> }) {
  const friendly = userFacingError(error);
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-destructive">
        <AlertTriangle className="size-4 shrink-0" />
        {friendly.title}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{friendly.message}</p>
    </div>
  );
}

function EmptySummary() {
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
      No model quota entries returned by MiniMax Token Plan API.
    </div>
  );
}

function CheckedAt({ checkedAt, now }: { checkedAt: string; now: number }) {
  return (
    <div className="text-[10px] text-muted-foreground">
      Checked:{" "}
      <span title={new Date(checkedAt).toLocaleString()}>
        {relativeTime(checkedAt, now)}
      </span>
    </div>
  );
}

function StatusBody({ status, now }: { status: SubscriptionUsageStatus; now: number }) {
  return (
    <>
      {!status.ok && status.error ? <ErrorBlock error={status.error} /> : null}

      {status.ok && status.windows && status.windows.length > 0 ? (
        <WindowsSection windows={status.windows} />
      ) : null}

      {status.ok && status.summary && status.summary.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <Database className="size-3.5" />
            Per-Model Breakdown
          </h3>
          <SummaryGrid summary={status.summary} />
        </div>
      )}

      {status.ok && (!status.summary || status.summary.length === 0) && (
        <div className="mt-4">
          <EmptySummary />
        </div>
      )}

      <div className="mt-4 border-t border-border/40 pt-3">
        <DashboardOnlySection
          icon={<Coins className="size-4" />}
          title="Credit Balance"
          description="Credit balance and purchase history are only available on the MiniMax dashboard."
          href="https://platform.minimax.io/billing/token-plan"
        />
        <DashboardOnlySection
          icon={<BarChart3 className="size-4" />}
          title="Usage History (today, 7d, 30d)"
          description="Historical usage statistics (daily, 7-day, and 30-day totals) are only available on the MiniMax dashboard."
          href="https://platform.minimax.io/billing/token-plan"
        />
      </div>
    </>
  );
}

function MiniMaxSubscriptionCard({
  status,
  now,
  onRefresh,
  refreshing,
  onTest,
  testing,
}: {
  status: SubscriptionUsageStatus | null;
  now: number;
  onRefresh: () => void;
  refreshing: boolean;
  onTest: () => void;
  testing: boolean;
}) {
  return (
    <section className="rounded-lg border border-border/60 bg-card/50 p-5 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">MiniMax Subscription Usage</h2>
            {status ? <CardPill status={status} /> : <LoadingPill />}
          </div>
          <p className="text-xs text-muted-foreground">
            Token Plan subscription usage fetched from MiniMax API. Uses{" "}
            <code className="font-mono">MINIMAX_SUBSCRIPTION_KEY</code>. Not API-billed.
          </p>
        </div>
      </div>

      {status ? <StatusBody status={status} now={now} /> : null}

      <div className="mt-3 flex items-center justify-between">
        {status ? <CheckedAt checkedAt={status.checkedAt} now={now} /> : <div />}
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onTest}
            disabled={testing}
            aria-label="Test live endpoint"
          >
            {testing ? (
              <Loader2 className="mr-1 size-3.5 animate-spin" />
            ) : (
              <Activity className="mr-1 size-3.5" />
            )}
            Test live endpoint
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh MiniMax subscription usage"
          >
            <RefreshCw className={cn("size-3.5", refreshing ? "animate-spin" : "")} />
            Refresh
          </Button>
        </div>
      </div>
    </section>
  );
}

export function SubscriptionUsagePanel() {
  const [statuses, setStatuses] = useState<SubscriptionUsageStatus[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await fetch("/api/subscription-usage", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as RouteResponse;
      setStatuses(data.statuses);
    } catch {
      // keep stale status on failure
    } finally {
      setRefreshing(false);
    }
  }, []);

  const testLive = useCallback(async () => {
    setTesting(true);
    try {
      const r = await fetch("/api/subscription-usage", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as RouteResponse;
      setStatuses(data.statuses);
    } catch (err) {
      setStatuses([{
        provider: "minimax",
        ok: false,
        source: "client",
        checkedAt: new Date().toISOString(),
        rawAvailable: false,
        credentialSource: "missing",
        error: {
          code: "request_failed",
          message: err instanceof Error ? err.message : "Request failed",
          retryable: true,
        },
      }]);
    } finally {
      setTesting(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const minimaxStatus = statuses?.find((s) => s.provider === "minimax") ?? null;

  return (
    <div className="flex w-full flex-col gap-4">
      {!minimaxStatus && statuses && statuses.length === 0 ? (
        <section className="rounded-lg border border-border/60 bg-card/50 p-5 shadow-xs">
          <p className="text-sm text-muted-foreground">No subscription usage data available.</p>
        </section>
      ) : (
        <MiniMaxSubscriptionCard
          status={minimaxStatus}
          now={now}
          onRefresh={load}
          refreshing={refreshing}
          onTest={testLive}
          testing={testing}
        />
      )}
    </div>
  );
}
