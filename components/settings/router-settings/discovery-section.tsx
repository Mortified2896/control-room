"use client";

import type { FC } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Section 0 · Provider model discovery.
 *
 * Kept above the three focused tabs (A/B/C) so the user has a sense of
 * what models are even catalogued before they start toggling visibilities
 * and reasoning options. The discovery surface has not changed semantically;
 * we just lift it into its own file so the three new tabs can stay focused.
 *
 * Discovery drives the EffectiveRegistry rows the tabs render. When
 * `fakeMode === true` (Playwright) the registry contains four fake ids
 * — the banner makes this obvious to dev users.
 */

type DiscoverySnapshot = {
  modelIds: ReadonlyArray<string>;
  fetchedAt: string | null;
  httpStatus: number | null;
  source: "openai" | "fake" | "fallback";
  rawCount: number | null;
  errorMessage: string | null;
  ageMs: number | null;
  isStale: boolean;
};

type Counts = {
  discovered: number;
  discoveredConfigured: number;
  discoveredUnclassified: number;
  configuredAvailable: number;
  stale: number;
  manualSelectorVisible: number;
  routerEligible: number;
};

type RefreshStatus =
  | { kind: "idle" }
  | { kind: "refreshing" }
  | {
      kind: "refreshed";
      at: number;
      modelCount: number;
      codexModelCount: number;
      minimaxModelCount: number;
      source: "openai" | "fake" | "minimax" | "cache_fresh";
    }
  | { kind: "refresh_error"; at: number; message: string };

function formatRelativeAge(ageMs: number | null): string {
  if (ageMs === null) return "never";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

type DiscoverySectionProps = {
  fakeMode: boolean;
  counts: Counts | undefined;
  discovery: DiscoverySnapshot | undefined;
  minimaxDiscovery: DiscoverySnapshot | undefined;
  refreshStatus: RefreshStatus;
  onRefresh: () => void;
};

export const DiscoverySection: FC<DiscoverySectionProps> = ({
  fakeMode,
  counts,
  discovery,
  minimaxDiscovery,
  refreshStatus,
  onRefresh,
}) => {
  return (
    <section
      aria-labelledby="discovery-heading"
      className="rounded-lg border border-border/60 bg-card p-4 sm:p-6"
      data-testid="router-settings-section-discovery"
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="discovery-heading" className="text-sm font-semibold">
            Provider model discovery
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            OpenAI API models use <code className="rounded bg-muted px-1">OPENAI_API_KEY</code> and
            OpenAI API billing. Control Room calls OpenAI&apos;s{" "}
            <code className="rounded bg-muted px-1">/v1/models</code> to learn which model ids are
            available to that API key. MiniMax API models use{" "}
            <code className="rounded bg-muted px-1">MINIMAX_API_KEY</code> and a MiniMax token plan.
            Control Room calls MiniMax&apos;s OpenAI-compatible{" "}
            <code className="rounded bg-muted px-1">/v1/models</code> endpoint and keeps a 24h
            cached snapshot.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={refreshStatus.kind === "refreshing"}
          data-testid="discovery-refresh-button"
        >
          {refreshStatus.kind === "refreshing" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          Refresh all provider models now
        </Button>
      </div>

      {fakeMode && (
        <div
          data-testid="discovery-fake-banner"
          className="mt-3 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          <AlertTriangle className="size-3.5 shrink-0" />
          Dev / Playwright mode: discovery returns a fixed list of four fake ids instead of calling
          OpenAI. Production builds never see fake ids unless this flag is set.
        </div>
      )}

      {/* Plain-English summary. The brief calls for "118 OpenAI models
          discovered, 3 fully configured, 115 available but unclassified"
          rather than the previous "118 / 3" shorthand. */}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="discovery-summary">
        <div
          className="rounded-md border border-border/60 px-3 py-2"
          data-testid="discovery-summary-discovered"
        >
          <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            OpenAI models discovered
          </dt>
          <dd className="mt-1 flex items-baseline gap-1 text-sm">
            <span className="text-lg font-semibold">{counts?.discovered ?? 0}</span>
            <span className="text-xs text-muted-foreground/70">total in latest refresh</span>
          </dd>
        </div>
        <div
          className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2"
          data-testid="discovery-summary-configured"
        >
          <dt className="text-[10px] font-medium uppercase tracking-wide text-emerald-700/80 dark:text-emerald-300/80">
            Fully configured
          </dt>
          <dd className="mt-1 flex items-baseline gap-1 text-sm">
            <span className="text-lg font-semibold text-emerald-700 dark:text-emerald-300">
              {counts?.discoveredConfigured ?? 0}
            </span>
            <span className="text-xs text-emerald-700/70 dark:text-emerald-300/70">
              have local metadata
            </span>
          </dd>
        </div>
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2"
          data-testid="discovery-summary-unclassified"
        >
          <dt className="text-[10px] font-medium uppercase tracking-wide text-amber-700/80 dark:text-amber-300/80">
            Available but unclassified
          </dt>
          <dd className="mt-1 flex items-baseline gap-1 text-sm">
            <span className="text-lg font-semibold text-amber-700 dark:text-amber-300">
              {counts?.discoveredUnclassified ?? 0}
            </span>
            <span className="text-xs text-amber-700/70 dark:text-amber-300/70">
              no local metadata
            </span>
          </dd>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="discovery-status">
        <div className="rounded-md border border-border/60 px-3 py-2">
          <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            Last refreshed
          </dt>
          <dd className="mt-1 text-sm">
            {discovery?.fetchedAt
              ? `${formatRelativeAge(discovery.ageMs)} (${discovery.source})`
              : "never"}
          </dd>
        </div>
        <div className="rounded-md border border-border/60 px-3 py-2">
          <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            Stale entries
          </dt>
          <dd className="mt-1 text-sm">
            {counts?.stale ?? 0}
            <span className="ml-1 text-xs text-muted-foreground/70">
              configured but disappeared
            </span>
          </dd>
        </div>
        <div className="rounded-md border border-border/60 px-3 py-2">
          <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            In manual picker
          </dt>
          <dd className="mt-1 text-sm">{counts?.manualSelectorVisible ?? 0}</dd>
        </div>
        <div className="rounded-md border border-border/60 px-3 py-2">
          <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            Recommender eligible
          </dt>
          <dd className="mt-1 text-sm">{counts?.routerEligible ?? 0}</dd>
        </div>
      </dl>

      <div
        className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3"
        data-testid="minimax-discovery-status"
      >
        <div className="rounded-md border border-border/60 px-3 py-2">
          <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            MiniMax models discovered
          </dt>
          <dd className="mt-1 flex items-baseline gap-1 text-sm">
            <span className="text-lg font-semibold">{minimaxDiscovery?.modelIds.length ?? 0}</span>
            <span className="text-xs text-muted-foreground/70">total in latest refresh</span>
          </dd>
        </div>
        <div className="rounded-md border border-border/60 px-3 py-2">
          <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            MiniMax last refreshed
          </dt>
          <dd className="mt-1 text-sm">
            {minimaxDiscovery?.fetchedAt
              ? `${formatRelativeAge(minimaxDiscovery.ageMs)} (${minimaxDiscovery.source})`
              : "never"}
          </dd>
        </div>
        <div className="rounded-md border border-border/60 px-3 py-2">
          <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            MiniMax status
          </dt>
          <dd className="mt-1 text-sm">
            {minimaxDiscovery?.isStale ? "stale / needs refresh" : "fresh"}
          </dd>
        </div>
      </div>

      {minimaxDiscovery?.errorMessage && (
        <div
          data-testid="minimax-discovery-error"
          className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div>
            <div className="font-medium">Last MiniMax refresh failed</div>
            <div className="text-destructive/80">{minimaxDiscovery.errorMessage}</div>
          </div>
        </div>
      )}

      {discovery?.errorMessage && (
        <div
          data-testid="discovery-error"
          className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div>
            <div className="font-medium">Last refresh failed</div>
            <div className="text-destructive/80">{discovery.errorMessage}</div>
          </div>
        </div>
      )}

      {refreshStatus.kind === "refreshed" && (
        <span
          className="mt-3 inline-flex text-xs text-muted-foreground"
          data-testid="discovery-refresh-status"
        >
          Refreshed {formatRelativeAge(Date.now() - refreshStatus.at)} ({refreshStatus.modelCount}{" "}
          OpenAI models, {refreshStatus.codexModelCount} Codex models,{" "}
          {refreshStatus.minimaxModelCount} MiniMax models).
        </span>
      )}
      {refreshStatus.kind === "refresh_error" && (
        <span
          className="mt-3 inline-flex text-xs text-destructive"
          data-testid="discovery-refresh-error"
        >
          Refresh failed: {refreshStatus.message}
        </span>
      )}
    </section>
  );
};
