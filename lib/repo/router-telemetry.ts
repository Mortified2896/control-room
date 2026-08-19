import "server-only";

import { tryDb } from "@/lib/db";
import type { EstimateQuality, LatencyResult, TokenResult } from "@/lib/router/telemetry";
import type {
  ChangedFieldKey,
  PanelCostTier,
  RoutingDecisionPanel,
  RoutingDecisionPanelSelection,
} from "@/lib/router/routing-decision-panel-types";

export async function createDecisionRun(input: {
  threadId?: string | null;
  projectId?: string | null;
  promptHash: string;
  promptText?: string | null;
  decision?: "normal_chat" | "coding_task" | null;
  reason?: string | null;
  estimateQuality: EstimateQuality;
  expectedLatencyMs: number;
  upperLatencyMs: number;
  startedAt: string;
  completedAt: string;
  actualLatencyMs: number;
  latencyDeviationMs: number;
  latencyDeviationPct: number | null;
  decisionSource?: "model" | "manual_after_model_error" | null;
  recommenderModelId?: string | null;
  ambiguity?: "low" | "medium" | "high" | null;
  signalsJson?: unknown;
  errorJson?: unknown;
}): Promise<string | null> {
  return tryDb(async (c) => {
    const r = await c.query<{ id: string }>(
      `insert into router_decision_runs (thread_id,project_id,prompt_hash,prompt_text,decision,reason,estimate_quality,expected_latency_ms,upper_latency_ms,started_at,completed_at,actual_latency_ms,latency_deviation_ms,latency_deviation_pct,decision_source,recommender_model_id,ambiguity,signals_json,error_json)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) returning id`,
      [
        input.threadId ?? null,
        input.projectId ?? null,
        input.promptHash,
        input.promptText ?? null,
        input.decision ?? null,
        input.reason ?? null,
        input.estimateQuality,
        input.expectedLatencyMs,
        input.upperLatencyMs,
        input.startedAt,
        input.completedAt,
        input.actualLatencyMs,
        input.latencyDeviationMs,
        input.latencyDeviationPct,
        input.decisionSource ?? null,
        input.recommenderModelId ?? null,
        input.ambiguity ?? null,
        input.signalsJson ? JSON.stringify(input.signalsJson) : null,
        input.errorJson ? JSON.stringify(input.errorJson) : null,
      ],
    );
    return r.rows[0]?.id ?? null;
  }, null);
}

export async function updateDecisionRun(input: {
  id: string;
  userAction: "approved" | "corrected_to_coding_task" | "corrected_to_normal_chat" | "canceled";
  userComment?: string | null;
  finalDecision?: "normal_chat" | "coding_task" | null;
}): Promise<void> {
  await tryDb(async (c) => {
    await c.query(
      `update router_decision_runs set user_action=$2,user_comment=$3,final_decision=$4,updated_at=now() where id=$1`,
      [input.id, input.userAction, input.userComment ?? null, input.finalDecision ?? null],
    );
  }, undefined);
}

export async function createRecommendationRun(input: {
  stepId: string;
  recommenderModelId: string;
  providerPath: string;
  promptHash: string;
  promptTokenEstimate: number;
  contextTokenEstimate: number;
  expectedLatencyMs: number;
  upperLatencyMs: number;
  estimateQuality: EstimateQuality;
  latencyPolicy: string;
  latencyBasis: string;
  historicalSampleCount: number;
  startedAt: string;
}): Promise<string | null> {
  return tryDb(async (c) => {
    const r = await c.query<{ id: string }>(
      `insert into router_recommendation_runs (step_id,recommender_model_id,provider_path,prompt_hash,prompt_token_estimate,telemetry_context_token_estimate,expected_latency_ms,upper_latency_ms,estimate_quality,latency_policy,latency_basis,historical_sample_count,started_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [
        input.stepId,
        input.recommenderModelId,
        input.providerPath,
        input.promptHash,
        input.promptTokenEstimate,
        input.contextTokenEstimate,
        input.expectedLatencyMs,
        input.upperLatencyMs,
        input.estimateQuality,
        input.latencyPolicy,
        input.latencyBasis,
        input.historicalSampleCount,
        input.startedAt,
      ],
    );
    return r.rows[0]?.id ?? null;
  }, null);
}

export async function completeRecommendationRun(
  id: string | null,
  input: {
    completedAt: string;
    actualLatencyMs: number;
    latencyDeviationMs: number;
    latencyDeviationPct: number | null;
    latencyResult: LatencyResult;
    recommendedModelId: string | null;
    alternativesJson?: unknown;
    reasoning?: string | null;
    fallbackUsed: boolean;
    errorJson?: unknown;
  },
): Promise<void> {
  if (!id) return;
  await tryDb(async (c) => {
    await c.query(
      `update router_recommendation_runs set completed_at=$2,actual_latency_ms=$3,latency_deviation_ms=$4,latency_deviation_pct=$5,latency_result=$6,recommended_model_id=$7,alternatives_json=$8,reasoning=$9,fallback_used=$10,error_json=$11 where id=$1`,
      [
        id,
        input.completedAt,
        input.actualLatencyMs,
        input.latencyDeviationMs,
        input.latencyDeviationPct,
        input.latencyResult,
        input.recommendedModelId,
        input.alternativesJson ? JSON.stringify(input.alternativesJson) : null,
        input.reasoning ?? null,
        input.fallbackUsed,
        input.errorJson ? JSON.stringify(input.errorJson) : null,
      ],
    );
  }, undefined);
}

export async function createExecutionRun(input: {
  recommendationRunId?: string | null;
  stepId: string;
  selectedModelId: string;
  providerPath: string;
  promptHash: string;
  promptTokenEstimate: number;
  contextTokenEstimate: number;
  expectedInputTokens: number;
  expectedOutputTokens: number;
  expectedTotalTokens: number;
  expectedExecutionLatencyMs: number;
  upperExecutionLatencyMs: number;
  executionEstimateQuality: EstimateQuality;
  estimatedCostUsd?: number | null;
  startedAt: string;
}): Promise<string | null> {
  return tryDb(async (c) => {
    const r = await c.query<{ id: string }>(
      `insert into router_execution_runs (recommendation_run_id,step_id,selected_model_id,provider_path,prompt_hash,prompt_token_estimate,context_token_estimate,expected_input_tokens,expected_output_tokens,expected_total_tokens,expected_execution_latency_ms,upper_execution_latency_ms,execution_estimate_quality,estimated_cost_usd,started_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
      [
        input.recommendationRunId ?? null,
        input.stepId,
        input.selectedModelId,
        input.providerPath,
        input.promptHash,
        input.promptTokenEstimate,
        input.contextTokenEstimate,
        input.expectedInputTokens,
        input.expectedOutputTokens,
        input.expectedTotalTokens,
        input.expectedExecutionLatencyMs,
        input.upperExecutionLatencyMs,
        input.executionEstimateQuality,
        input.estimatedCostUsd ?? null,
        input.startedAt,
      ],
    );
    return r.rows[0]?.id ?? null;
  }, null);
}

export async function completeExecutionRun(
  id: string | null,
  input: {
    completedAt: string;
    actualInputTokens: number;
    actualOutputTokens: number;
    actualTotalTokens: number;
    actualExecutionLatencyMs: number;
    latencyDeviationMs: number;
    latencyDeviationPct: number | null;
    tokenDeviationCount: number;
    tokenDeviationPct: number | null;
    latencyResult: LatencyResult;
    tokenResult: TokenResult;
    success: boolean;
    errorJson?: unknown;
  },
): Promise<void> {
  if (!id) return;
  await tryDb(async (c) => {
    await c.query(
      `update router_execution_runs set completed_at=$2,actual_input_tokens=$3,actual_output_tokens=$4,actual_total_tokens=$5,actual_execution_latency_ms=$6,latency_deviation_ms=$7,latency_deviation_pct=$8,token_deviation_count=$9,token_deviation_pct=$10,latency_result=$11,token_result=$12,success=$13,error_json=$14 where id=$1`,
      [
        id,
        input.completedAt,
        input.actualInputTokens,
        input.actualOutputTokens,
        input.actualTotalTokens,
        input.actualExecutionLatencyMs,
        input.latencyDeviationMs,
        input.latencyDeviationPct,
        input.tokenDeviationCount,
        input.tokenDeviationPct,
        input.latencyResult,
        input.tokenResult,
        input.success,
        input.errorJson ? JSON.stringify(input.errorJson) : null,
      ],
    );
  }, undefined);
}

/**
 * Routing Decision Panel telemetry — additive helpers for the
 * new compact editable panel that replaces the step-by-step
 * recommendation card.
 *
 * Hard rules (from the panel brief):
 *   - The original recommendation (`panel`) is immutable post-
 *     persist; only the user's `selection`, `changed_fields`,
 *     and `comment` are mutable.
 *   - The comment is the only free-form annotation; the diff
 *     (`changed_fields`) is a closed enum array so dashboards
 *     can compute correction rates per field.
 *   - `tryDb` returns `null` when the DB is unavailable; the
 *     chat send path treats a `null` row id as "best-effort
 *     telemetry, proceed with the send" rather than failing
 *     the user-visible action.
 */
export type CreateFullRoutingDecisionRunInput = {
  threadId?: string | null;
  projectId?: string | null;
  promptHash: string;
  promptText?: string | null;
  panel: RoutingDecisionPanel;
  selection: RoutingDecisionPanelSelection;
  changedFields: ReadonlyArray<ChangedFieldKey>;
  comment?: string | null;
  recommendationRunId?: string | null;
  confidence?: number | null;
  costTier?: PanelCostTier | null;
  latencyMs?: number | null;
};

export async function createFullRoutingDecisionRun(
  input: CreateFullRoutingDecisionRunInput,
): Promise<string | null> {
  return tryDb(async (c) => {
    const r = await c.query<{ id: string }>(
      `insert into routing_decision_panel_runs (
         thread_id,
         project_id,
         prompt_hash,
         prompt_text,
         panel,
         selection,
         changed_fields,
         comment,
         recommendation_run_id,
         confidence,
         cost_tier,
         latency_ms
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
      [
        input.threadId ?? null,
        input.projectId ?? null,
        input.promptHash,
        input.promptText ?? null,
        JSON.stringify(input.panel),
        JSON.stringify(input.selection),
        JSON.stringify(input.changedFields),
        // The brief caps the comment at 1000 chars; enforce here so a
        // regression in the route cannot smuggle an unbounded
        // payload into the DB column.
        input.comment && input.comment.length > 0
          ? input.comment.slice(0, 1000)
          : null,
        input.recommendationRunId ?? null,
        input.confidence ?? null,
        input.costTier ?? null,
        input.latencyMs ?? null,
      ],
    );
    return r.rows[0]?.id ?? null;
  }, null);
}

export async function updateFullRoutingDecisionRun(
  id: string,
  input: {
    selection?: RoutingDecisionPanelSelection;
    changedFields?: ReadonlyArray<ChangedFieldKey>;
    comment?: string | null;
  },
): Promise<void> {
  if (!id) return;
  await tryDb(async (c) => {
    await c.query(
      `update routing_decision_panel_runs set selection = $2, changed_fields = $3, comment = $4, updated_at = now() where id = $1`,
      [
        id,
        input.selection ? JSON.stringify(input.selection) : null,
        input.changedFields ? JSON.stringify(input.changedFields) : null,
        // Empty string → null so the column is queryable for
        // "comment present" vs "comment absent" without a
        // string-emptiness check.
        input.comment && input.comment.length > 0
          ? input.comment.slice(0, 1000)
          : null,
      ],
    );
  }, undefined);
}
