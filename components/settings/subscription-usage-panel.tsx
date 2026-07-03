"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";

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

function userFacingError(status: SubscriptionUsageStatus): {
  title: string;
  message: string;
} {
  const code = status.error?.code ?? "";
  const msg = status.error?.message ?? "";

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
  return { title: code, message: msg };
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
  const friendly = userFacingError({
    ok: false,
    error,
  } as SubscriptionUsageStatus);
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

/**
 * Auto-loading card that shows the last known MiniMax subscription usage
 * status from the server-side fetcher.  Includes a Refresh button that
 * replaces the auto-loaded state.
 */
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
            {status ? <CardPill status={status} /> : <LoadingPill />}
          </div>
          <p className="text-xs text-muted-foreground">
            Token Plan subscription usage fetched from MiniMax API. Uses{" "}
            <code className="font-mono">MINIMAX_SUBSCRIPTION_KEY</code>. Not API-billed.
          </p>
        </div>
      </div>

      {status && !status.ok && status.error ? <ErrorBlock error={status.error} /> : null}

      {status && status.ok && status.summary && status.summary.length > 0 ? (
        <div className="mt-4">
          <SummaryGrid summary={status.summary} />
        </div>
      ) : null}

      {status && status.ok && (!status.summary || status.summary.length === 0) ? (
        <div className="mt-4">
          <EmptySummary />
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-between">
        {status ? <CheckedAt checkedAt={status.checkedAt} now={now} /> : <div />}
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
    </section>
  );
}

/**
 * Explicit one-shot test panel.  Clicking the button performs a fresh
 * live call to the MiniMax Token Plan endpoint and shows only the result
 * of that single call — it never mixes with the auto-loaded state.
 */
function MiniMaxLiveTest({
  now,
}: {
  now: number;
}) {
  const [result, setResult] = useState<SubscriptionUsageStatus | "idle" | "loading">("idle");

  const run = useCallback(async () => {
    setResult("loading");
    try {
      const r = await fetch("/api/subscription-usage", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as RouteResponse;
      const mm = data.statuses.find((s) => s.provider === "minimax");
      setResult(mm ?? {
        provider: "minimax",
        ok: false,
        source: "client",
        checkedAt: new Date().toISOString(),
        rawAvailable: false,
        credentialSource: "missing",
        error: { code: "no_status_returned", message: "No MiniMax status in response", retryable: false },
      });
    } catch (err) {
      setResult({
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
      });
    }
  }, []);

  return (
    <section className="rounded-lg border border-border/60 bg-card/50 p-5 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">MiniMax live subscription endpoint</h2>
            {result === "loading" ? (
              <LoadingPill />
            ) : typeof result === "object" ? (
              <CardPill status={result} />
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Calls{" "}
            <code className="font-mono">GET /v1/token_plan/remains</code> live and shows the
            normalized result. Does not use cached or estimated data.
          </p>
        </div>
      </div>

      {result === "idle" ? (
        <div className="mt-4 rounded-md border border-border/60 bg-muted/20 p-4 text-center text-sm text-muted-foreground">
          Click the button below to test the MiniMax subscription endpoint.
        </div>
      ) : null}

      {result === "loading" ? (
        <div className="mt-4 rounded-md border border-border/60 bg-muted/20 p-4 text-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 inline size-4 animate-spin" />
          Calling MiniMax Token Plan endpoint…
        </div>
      ) : null}

      {typeof result === "object" && !result.ok && result.error ? (
        <div className="mt-4">
          <ErrorBlock error={result.error} />
        </div>
      ) : null}

      {typeof result === "object" && result.ok && result.summary && result.summary.length > 0 ? (
        <div className="mt-4">
          <SummaryGrid summary={result.summary} />
        </div>
      ) : null}

      {typeof result === "object" && result.ok && (!result.summary || result.summary.length === 0) ? (
        <div className="mt-4">
          <EmptySummary />
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-between">
        {typeof result === "object" ? (
          <CheckedAt checkedAt={result.checkedAt} now={now} />
        ) : (
          <div />
        )}
        <Button
          variant="default"
          size="sm"
          onClick={run}
          disabled={result === "loading"}
          aria-label="Test MiniMax live usage"
        >
          {result === "loading" ? (
            <Loader2 className="mr-1 size-3.5 animate-spin" />
          ) : (
            <Activity className="mr-1 size-3.5" />
          )}
          Test MiniMax live usage
        </Button>
      </div>
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
    } catch {
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

      <MiniMaxLiveTest now={now} />
    </div>
  );
}
