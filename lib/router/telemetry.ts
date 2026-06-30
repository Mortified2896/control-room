import "server-only";

import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { tryDb } from "@/lib/db";

export type EstimateQuality = "likely" | "uncertain" | "rough";
export type LatencyResult = "on time" | "faster than expected" | "slower than expected" | "unusually slow";
export type TokenResult = "near estimate" | "under estimate" | "over estimate";

export function promptHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.trim().length / 4));
}

function bucket(tokens: number): string {
  if (tokens < 500) return "lt_500";
  if (tokens < 2_000) return "500_2k";
  if (tokens < 8_000) return "2k_8k";
  return "gt_8k";
}

function classifyLatency(actualMs: number, expectedMs: number, upperMs: number): LatencyResult {
  if (actualMs < expectedMs * 0.8) return "faster than expected";
  if (actualMs <= expectedMs * 1.25) return "on time";
  if (actualMs <= upperMs) return "slower than expected";
  return "unusually slow";
}

export function classifyTokens(actual: number, expected: number): TokenResult {
  if (actual < expected * 0.85) return "under estimate";
  if (actual > expected * 1.15) return "over estimate";
  return "near estimate";
}

type Hist = { sampleCount: number; avgMs: number | null; p50Ms: number | null; p99Ms: number | null; avgIn: number | null; avgOut: number | null };

async function recommendationHistory(c: PoolClient, modelId: string, stepId: string, tokenEstimate: number): Promise<Hist> {
  const b = bucket(tokenEstimate);
  const res = await c.query(
    `select count(*)::int as sample_count,
            avg(actual_latency_ms)::float as avg_ms,
            percentile_cont(0.5) within group (order by actual_latency_ms)::float as p50_ms,
            percentile_cont(0.99) within group (order by actual_latency_ms)::float as p99_ms
       from router_recommendation_runs
      where recommender_model_id=$1 and step_id=$2 and actual_latency_ms is not null
        and case when prompt_token_estimate < 500 then 'lt_500'
                 when prompt_token_estimate < 2000 then '500_2k'
                 when prompt_token_estimate < 8000 then '2k_8k' else 'gt_8k' end = $3`,
    [modelId, stepId, b],
  );
  const r = res.rows[0] ?? {};
  return { sampleCount: r.sample_count ?? 0, avgMs: r.avg_ms ?? null, p50Ms: r.p50_ms ?? null, p99Ms: r.p99_ms ?? null, avgIn: null, avgOut: null };
}

async function executionHistory(c: PoolClient, modelId: string, stepId: string, tokenEstimate: number): Promise<Hist> {
  const b = bucket(tokenEstimate);
  const res = await c.query(
    `select count(*)::int as sample_count,
            avg(actual_execution_latency_ms)::float as avg_ms,
            percentile_cont(0.5) within group (order by actual_execution_latency_ms)::float as p50_ms,
            percentile_cont(0.99) within group (order by actual_execution_latency_ms)::float as p99_ms,
            avg(actual_input_tokens)::float as avg_in,
            avg(actual_output_tokens)::float as avg_out
       from router_execution_runs
      where selected_model_id=$1 and step_id=$2 and actual_execution_latency_ms is not null
        and case when prompt_token_estimate < 500 then 'lt_500'
                 when prompt_token_estimate < 2000 then '500_2k'
                 when prompt_token_estimate < 8000 then '2k_8k' else 'gt_8k' end = $3`,
    [modelId, stepId, b],
  );
  const r = res.rows[0] ?? {};
  return { sampleCount: r.sample_count ?? 0, avgMs: r.avg_ms ?? null, p50Ms: r.p50_ms ?? null, p99Ms: r.p99_ms ?? null, avgIn: r.avg_in ?? null, avgOut: r.avg_out ?? null };
}

export type RecommendationEstimate = {
  expectedLatencyMs: number; upperLatencyMs: number; estimateQuality: EstimateQuality; latencyPolicy: string; latencyBasis: string; historicalSampleCount: number;
};

export async function estimateRecommendation(args: { recommenderModelId: string; providerPath: string; promptTokenEstimate: number; contextTokenEstimate: number; stepId?: string }): Promise<RecommendationEstimate> {
  const heuristic = Math.min(15_000, Math.max(3_000, 2_000 + args.promptTokenEstimate * 3 + args.contextTokenEstimate));
  const hist = await tryDb((c) => recommendationHistory(c, args.recommenderModelId, args.stepId ?? "normal_chat", args.promptTokenEstimate), { sampleCount: 0, avgMs: null, p50Ms: null, p99Ms: null, avgIn: null, avgOut: null });
  if (hist.sampleCount >= 100 && hist.p50Ms && hist.p99Ms) return { expectedLatencyMs: Math.round(hist.p50Ms), upperLatencyMs: Math.round(hist.p99Ms), estimateQuality: "likely", latencyPolicy: "p50_p99_v1", latencyBasis: "historical", historicalSampleCount: hist.sampleCount };
  if (hist.sampleCount >= 30 && hist.p50Ms && hist.p99Ms) return { expectedLatencyMs: Math.round((heuristic + hist.p50Ms) / 2), upperLatencyMs: Math.round((heuristic * 2.5 + hist.p99Ms) / 2), estimateQuality: "uncertain", latencyPolicy: "blend_p50_p99_v1", latencyBasis: "blended", historicalSampleCount: hist.sampleCount };
  return { expectedLatencyMs: heuristic, upperLatencyMs: Math.round(heuristic * 2.5), estimateQuality: hist.sampleCount > 0 ? "uncertain" : "rough", latencyPolicy: "heuristic_p50_p99_v1", latencyBasis: "heuristic", historicalSampleCount: hist.sampleCount };
}

export type ExecutionEstimate = RecommendationEstimate & { expectedInputTokens: number; expectedOutputTokens: number; expectedTotalTokens: number; estimatedCostUsd: number | null };

export async function estimateExecution(args: { selectedModelId: string; providerPath: string; promptTokenEstimate: number; contextTokenEstimate: number; maxOutputTokens?: number; stepId?: string }): Promise<ExecutionEstimate> {
  const input = args.promptTokenEstimate + args.contextTokenEstimate;
  const fallbackOut = Math.min(args.maxOutputTokens ?? 2_000, Math.max(250, Math.round(args.promptTokenEstimate * 0.8)));
  const heuristicMs = Math.min(120_000, Math.max(5_000, 3_000 + input * 2 + fallbackOut * 12));
  const hist = await tryDb((c) => executionHistory(c, args.selectedModelId, args.stepId ?? "normal_chat", args.promptTokenEstimate), { sampleCount: 0, avgMs: null, p50Ms: null, p99Ms: null, avgIn: null, avgOut: null });
  const out = hist.sampleCount >= 30 && hist.avgOut ? Math.round((fallbackOut + hist.avgOut) / 2) : fallbackOut;
  if (hist.sampleCount >= 100 && hist.p50Ms && hist.p99Ms) return { expectedLatencyMs: Math.round(hist.p50Ms), upperLatencyMs: Math.round(hist.p99Ms), estimateQuality: "likely", latencyPolicy: "p50_p99_tokens_v1", latencyBasis: "historical", historicalSampleCount: hist.sampleCount, expectedInputTokens: input, expectedOutputTokens: out, expectedTotalTokens: input + out, estimatedCostUsd: null };
  if (hist.sampleCount >= 30 && hist.p50Ms && hist.p99Ms) return { expectedLatencyMs: Math.round((heuristicMs + hist.p50Ms) / 2), upperLatencyMs: Math.round((heuristicMs * 2.5 + hist.p99Ms) / 2), estimateQuality: "uncertain", latencyPolicy: "blend_p50_p99_tokens_v1", latencyBasis: "blended", historicalSampleCount: hist.sampleCount, expectedInputTokens: input, expectedOutputTokens: out, expectedTotalTokens: input + out, estimatedCostUsd: null };
  return { expectedLatencyMs: heuristicMs, upperLatencyMs: Math.round(heuristicMs * 2.5), estimateQuality: hist.sampleCount > 0 ? "uncertain" : "rough", latencyPolicy: "heuristic_tokens_v1", latencyBasis: "heuristic", historicalSampleCount: hist.sampleCount, expectedInputTokens: input, expectedOutputTokens: out, expectedTotalTokens: input + out, estimatedCostUsd: null };
}

export function latencyOutcome(actualMs: number, expectedMs: number, upperMs: number) {
  const deviationMs = actualMs - expectedMs;
  return { deviationMs, deviationPct: expectedMs > 0 ? (deviationMs / expectedMs) * 100 : null, result: classifyLatency(actualMs, expectedMs, upperMs) };
}
