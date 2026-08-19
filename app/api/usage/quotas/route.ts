import "server-only";

import { NextResponse } from "next/server";
import { tryDb } from "@/lib/db";
import { latestSnapshotByProvider } from "@/lib/repo/provider-usage-snapshots";

export const runtime = "nodejs";

type UsageQuotaProvider = {
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
};

type RecentRun = {
  providerId: string;
  label: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  at: string | null;
};

type UsageRow = {
  provider_id: string;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  total_tokens: string | number | null;
  last_updated: string | Date | null;
};

type EventRow = { provider_id: string; count: string | number | null };
type RunRow = {
  provider_id: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  at: string | Date | null;
};

const baseProviders: UsageQuotaProvider[] = [
  baseProvider("minimax", "MiniMax subscription", "subscription", "active"),
  baseProvider("codex", "Codex subscription", "subscription", "active"),
  {
    ...baseProvider("openai", "OpenAI API", "api", "disabled"),
    status: "disabled",
    confidence: "unknown",
  },
];

function baseProvider(
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

function toNumber(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function iso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function providerIdFromPathSql(alias: string) {
  return `case
    when lower(${alias}) like '%minimax%' then 'minimax'
    when lower(${alias}) like '%codex%' then 'codex'
    when lower(${alias}) like '%openai%' then 'openai'
    else 'unknown'
  end`;
}

export async function GET() {
  const empty = { usage: [] as UsageRow[], events: [] as EventRow[], runs: [] as RunRow[] };
  const local = await tryDb(async (c) => {
    const usage = await c.query<UsageRow>(`
      select provider_id,
             sum(input_tokens)::bigint as input_tokens,
             sum(output_tokens)::bigint as output_tokens,
             sum(total_tokens)::bigint as total_tokens,
             max(last_updated) as last_updated
      from (
        select ${providerIdFromPathSql("provider_path")} as provider_id,
               coalesce(actual_input_tokens, expected_input_tokens) as input_tokens,
               coalesce(actual_output_tokens, expected_output_tokens) as output_tokens,
               coalesce(actual_total_tokens, expected_total_tokens) as total_tokens,
               coalesce(completed_at, started_at, created_at) as last_updated
        from router_execution_runs
        where created_at >= now() - interval '30 days'
      ) s
      where provider_id in ('minimax','codex','openai')
      group by provider_id
    `);

    const events = await c.query<EventRow>(`
      select provider_id, count(*)::bigint as count
      from (
        select ${providerIdFromPathSql("executor")} as provider_id, stderr || E'\n' || stdout as text
        from coding_runs
        where created_at >= now() - interval '30 days'
      ) s
      where provider_id in ('minimax','codex')
        and text ~* '(usage limit|quota|rate.?limit|token plan exhausted)'
      group by provider_id
    `);

    const runs = await c.query<RunRow>(`
      select provider_id, input_tokens, output_tokens, total_tokens, at
      from (
        select ${providerIdFromPathSql("provider_path")} as provider_id,
               coalesce(actual_input_tokens, expected_input_tokens) as input_tokens,
               coalesce(actual_output_tokens, expected_output_tokens) as output_tokens,
               coalesce(actual_total_tokens, expected_total_tokens) as total_tokens,
               coalesce(completed_at, started_at, created_at) as at
        from router_execution_runs
        where created_at >= now() - interval '30 days'
        order by created_at desc
        limit 10
      ) s
      where provider_id in ('minimax','codex','openai')
    `);

    return { usage: usage.rows, events: events.rows, runs: runs.rows };
  }, empty);

  const usageByProvider = new Map(local.usage.map((row) => [row.provider_id, row]));
  const eventsByProvider = new Map(
    local.events.map((row) => [row.provider_id, toNumber(row.count) ?? 0]),
  );

  // Overlay the latest confirmed snapshot per provider on top of the
  // local-log estimate. The snapshot takes precedence for the
  // user-confirmed fields (shortWindow*, weeklyWindow*, resetWindow*)
  // and stamps `confidence: "observed"`. Local estimates remain the
  // source of truth for token counts.
  const snapshotByProvider: Record<
    string,
    Awaited<ReturnType<typeof latestSnapshotByProvider>>
  > = {};
  await Promise.all(
    baseProviders.map(async (p) => {
      snapshotByProvider[p.providerId] = await latestSnapshotByProvider(p.providerId);
    }),
  );

  const providers = baseProviders.map((provider) => {
    const row = usageByProvider.get(provider.providerId);
    const total = toNumber(row?.total_tokens);
    const input = toNumber(row?.input_tokens);
    const output = toNumber(row?.output_tokens);
    const snap = snapshotByProvider[provider.providerId] ?? null;
    const snapReset = snap?.shortWindowResetLabel ?? snap?.weeklyWindowResetLabel ?? null;
    const hasSnapshotWindow =
      snap !== null &&
      (snap.shortWindowUsedPercent !== null ||
        snap.shortWindowRemainingPercent !== null ||
        snap.weeklyWindowUsedPercent !== null ||
        snap.weeklyWindowRemainingPercent !== null);
    return {
      ...provider,
      confidence: hasSnapshotWindow
        ? (snap?.confidence ?? "observed")
        : total === null
          ? provider.confidence
          : "estimated",
      estimatedInputTokens: input,
      estimatedOutputTokens: output,
      estimatedTotalTokens: total,
      configuredLimitTokens: null,
      estimatedRemainingTokens: null,
      resetWindowLabel: snapReset,
      recentLimitEvents: eventsByProvider.get(provider.providerId) ?? 0,
      lastUpdated: iso(snap?.capturedAt ?? row?.last_updated),
      // New snapshot-derived fields. The UI reads these directly when
      // available so it does not have to do a second fetch.
      shortWindowLabel: snap?.shortWindowLabel ?? null,
      shortWindowUsedPercent: snap?.shortWindowUsedPercent ?? null,
      shortWindowRemainingPercent: snap?.shortWindowRemainingPercent ?? null,
      weeklyWindowLabel: snap?.weeklyWindowLabel ?? null,
      weeklyWindowUsedPercent: snap?.weeklyWindowUsedPercent ?? null,
      weeklyWindowRemainingPercent: snap?.weeklyWindowRemainingPercent ?? null,
      creditsRemaining: snap?.creditsRemaining ?? null,
      planName: snap?.planName ?? null,
      last7DaysUsage: snap?.last7DaysUsage ?? null,
      last30DaysUsage: snap?.last30DaysUsage ?? null,
      usageAtTimestampValue: snap?.usageAtTimestampValue ?? null,
      usageAtTimestampLabel: snap?.usageAtTimestampLabel ?? null,
      snapshotCapturedAt: snap?.capturedAt ?? null,
      snapshotSourceType: snap?.sourceType ?? null,
    } satisfies UsageQuotaProvider & {
      shortWindowLabel: string | null;
      shortWindowUsedPercent: number | null;
      shortWindowRemainingPercent: number | null;
      weeklyWindowLabel: string | null;
      weeklyWindowUsedPercent: number | null;
      weeklyWindowRemainingPercent: number | null;
      creditsRemaining: number | null;
      planName: string | null;
      last7DaysUsage: string | null;
      last30DaysUsage: string | null;
      usageAtTimestampValue: string | null;
      usageAtTimestampLabel: string | null;
      snapshotCapturedAt: string | null;
      snapshotSourceType: string | null;
    };
  });

  const labelByProvider = new Map(providers.map((p) => [p.providerId, p.label]));
  const recentRuns: RecentRun[] = local.runs.map((run) => ({
    providerId: run.provider_id,
    label: labelByProvider.get(run.provider_id) ?? run.provider_id,
    inputTokens: run.input_tokens,
    outputTokens: run.output_tokens,
    totalTokens: run.total_tokens,
    at: iso(run.at),
  }));

  return NextResponse.json({
    providers,
    recentRuns,
    generatedAt: new Date().toISOString(),
    source:
      local.usage.length || local.events.length || local.runs.length ? "local_logs" : "placeholder",
  });
}
