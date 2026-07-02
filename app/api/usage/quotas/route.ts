import "server-only";

import { NextResponse } from "next/server";
import { tryDb } from "@/lib/db";

export const runtime = "nodejs";

type UsageQuotaProvider = {
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
  const eventsByProvider = new Map(local.events.map((row) => [row.provider_id, toNumber(row.count) ?? 0]));

  const providers = baseProviders.map((provider) => {
    const row = usageByProvider.get(provider.providerId);
    const total = toNumber(row?.total_tokens);
    const input = toNumber(row?.input_tokens);
    const output = toNumber(row?.output_tokens);
    return {
      ...provider,
      confidence: total === null ? provider.confidence : "estimated",
      estimatedInputTokens: input,
      estimatedOutputTokens: output,
      estimatedTotalTokens: total,
      // v1 intentionally does not invent subscription limits or reset windows.
      configuredLimitTokens: null,
      estimatedRemainingTokens: null,
      resetWindowLabel: null,
      recentLimitEvents: eventsByProvider.get(provider.providerId) ?? 0,
      lastUpdated: iso(row?.last_updated),
    } satisfies UsageQuotaProvider;
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
    source: local.usage.length || local.events.length || local.runs.length ? "local_logs" : "placeholder",
  });
}
