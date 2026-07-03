"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { SubscriptionUsageStatus } from "@/lib/minimax/subscription-usage";

type RouteResponse = {
  statuses: SubscriptionUsageStatus[];
};

function pct(value: number | undefined | null): string {
  if (value == null) return "—";
  return `${Math.round(value)}%`;
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

function MiniMaxSubscriptionCard({
  status,
  now,
  onRefresh,
  refreshing,
}: {
  status: SubscriptionUsageStatus | null;
  now: number;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <section className="rounded-lg border border-border/60 bg-card/50 p-5 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">MiniMax Subscription Usage</h2>
            {status ? (
              status.ok ? (
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
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-500/30 dark:text-amber-300">
                  <AlertTriangle className="size-3.5" />
                  Unavailable
                </span>
              )
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground ring-1 ring-inset ring-border">
                <Loader2 className="size-3.5 animate-spin" />
                Checking…
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Token Plan subscription usage fetched from MiniMax API. Uses{" "}
            <code className="font-mono">MINIMAX_SUBSCRIPTION_KEY</code>. Not API-billed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh MiniMax subscription usage"
          >
            <RefreshCw
              className={cn("size-3.5", refreshing ? "animate-spin" : "")}
            />
            Refresh
          </Button>
        </div>
      </div>

      {status && !status.ok && status.error ? (
        <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <div className="flex items-center gap-2 font-medium text-destructive">
            <AlertTriangle className="size-4" />
            {status.error.code}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{status.error.message}</p>
        </div>
      ) : null}

      {status && status.ok && status.summary && status.summary.length > 0 ? (
        <div className="mt-4 space-y-3">
          {status.summary.map((item, i) => (
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
                      <span className="text-right font-mono">
                        {pct(item.remainingPercent)}
                      </span>
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
      ) : null}

      {status && status.ok && (!status.summary || status.summary.length === 0) ? (
        <div className="mt-4 rounded-md border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
          No model quota entries returned by MiniMax Token Plan API.
        </div>
      ) : null}

      {status ? (
        <div className="mt-3 text-[10px] text-muted-foreground">
          Checked:{" "}
          <span title={new Date(status.checkedAt).toLocaleString()}>
            {relativeTime(status.checkedAt, now)}
          </span>
        </div>
      ) : null}
    </section>
  );
}

export function SubscriptionUsagePanel() {
  const [statuses, setStatuses] = useState<SubscriptionUsageStatus[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await fetch("/api/subscription-usage", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as RouteResponse;
      setStatuses(data.statuses);
    } catch (err) {
      // keep stale status on failure
    } finally {
      setRefreshing(false);
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
        />
      )}
    </div>
  );
}
