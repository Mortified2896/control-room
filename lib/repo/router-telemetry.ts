import "server-only";

import { tryDb } from "@/lib/db";
import type { EstimateQuality, LatencyResult, TokenResult } from "@/lib/router/telemetry";

export async function createRecommendationRun(input: {
  stepId: string; recommenderModelId: string; providerPath: string; promptHash: string; promptTokenEstimate: number; contextTokenEstimate: number; expectedLatencyMs: number; upperLatencyMs: number; estimateQuality: EstimateQuality; latencyPolicy: string; latencyBasis: string; historicalSampleCount: number; startedAt: string;
}): Promise<string | null> {
  return tryDb(async (c) => {
    const r = await c.query<{ id: string }>(
      `insert into router_recommendation_runs (step_id,recommender_model_id,provider_path,prompt_hash,prompt_token_estimate,telemetry_context_token_estimate,expected_latency_ms,upper_latency_ms,estimate_quality,latency_policy,latency_basis,historical_sample_count,started_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [input.stepId,input.recommenderModelId,input.providerPath,input.promptHash,input.promptTokenEstimate,input.contextTokenEstimate,input.expectedLatencyMs,input.upperLatencyMs,input.estimateQuality,input.latencyPolicy,input.latencyBasis,input.historicalSampleCount,input.startedAt],
    );
    return r.rows[0]?.id ?? null;
  }, null);
}

export async function completeRecommendationRun(id: string | null, input: { completedAt: string; actualLatencyMs: number; latencyDeviationMs: number; latencyDeviationPct: number | null; latencyResult: LatencyResult; recommendedModelId: string | null; alternativesJson?: unknown; reasoning?: string | null; fallbackUsed: boolean; errorJson?: unknown }): Promise<void> {
  if (!id) return;
  await tryDb(async (c) => { await c.query(
    `update router_recommendation_runs set completed_at=$2,actual_latency_ms=$3,latency_deviation_ms=$4,latency_deviation_pct=$5,latency_result=$6,recommended_model_id=$7,alternatives_json=$8,reasoning=$9,fallback_used=$10,error_json=$11 where id=$1`,
    [id,input.completedAt,input.actualLatencyMs,input.latencyDeviationMs,input.latencyDeviationPct,input.latencyResult,input.recommendedModelId,input.alternativesJson ? JSON.stringify(input.alternativesJson) : null,input.reasoning ?? null,input.fallbackUsed,input.errorJson ? JSON.stringify(input.errorJson) : null],
  ); }, undefined);
}

export async function createExecutionRun(input: {
  recommendationRunId?: string | null; stepId: string; selectedModelId: string; providerPath: string; promptHash: string; promptTokenEstimate: number; contextTokenEstimate: number; expectedInputTokens: number; expectedOutputTokens: number; expectedTotalTokens: number; expectedExecutionLatencyMs: number; upperExecutionLatencyMs: number; executionEstimateQuality: EstimateQuality; estimatedCostUsd?: number | null; startedAt: string;
}): Promise<string | null> {
  return tryDb(async (c) => {
    const r = await c.query<{ id: string }>(
      `insert into router_execution_runs (recommendation_run_id,step_id,selected_model_id,provider_path,prompt_hash,prompt_token_estimate,context_token_estimate,expected_input_tokens,expected_output_tokens,expected_total_tokens,expected_execution_latency_ms,upper_execution_latency_ms,execution_estimate_quality,estimated_cost_usd,started_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
      [input.recommendationRunId ?? null,input.stepId,input.selectedModelId,input.providerPath,input.promptHash,input.promptTokenEstimate,input.contextTokenEstimate,input.expectedInputTokens,input.expectedOutputTokens,input.expectedTotalTokens,input.expectedExecutionLatencyMs,input.upperExecutionLatencyMs,input.executionEstimateQuality,input.estimatedCostUsd ?? null,input.startedAt],
    );
    return r.rows[0]?.id ?? null;
  }, null);
}

export async function completeExecutionRun(id: string | null, input: { completedAt: string; actualInputTokens: number; actualOutputTokens: number; actualTotalTokens: number; actualExecutionLatencyMs: number; latencyDeviationMs: number; latencyDeviationPct: number | null; tokenDeviationCount: number; tokenDeviationPct: number | null; latencyResult: LatencyResult; tokenResult: TokenResult; success: boolean; errorJson?: unknown }): Promise<void> {
  if (!id) return;
  await tryDb(async (c) => { await c.query(
    `update router_execution_runs set completed_at=$2,actual_input_tokens=$3,actual_output_tokens=$4,actual_total_tokens=$5,actual_execution_latency_ms=$6,latency_deviation_ms=$7,latency_deviation_pct=$8,token_deviation_count=$9,token_deviation_pct=$10,latency_result=$11,token_result=$12,success=$13,error_json=$14 where id=$1`,
    [id,input.completedAt,input.actualInputTokens,input.actualOutputTokens,input.actualTotalTokens,input.actualExecutionLatencyMs,input.latencyDeviationMs,input.latencyDeviationPct,input.tokenDeviationCount,input.tokenDeviationPct,input.latencyResult,input.tokenResult,input.success,input.errorJson ? JSON.stringify(input.errorJson) : null],
  ); }, undefined);
}
