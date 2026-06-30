/**
 * Zod schemas for the Router A/B data parts emitted by `/api/chat`.
 *
 * The `useChatRuntime({ dataPartSchemas })` option type-validates the data
 * parts the chat transport parses out of the SSE stream, and it also keeps
 * the data parts attached to the assistant message state (otherwise the
 * unknown data parts would be discarded). Both schemas must be present.
 */
import { z } from "zod/v4";
import type { RouterAbDataParts } from "@/app/api/chat/route";

const routerAbSchema = z.object({
  sessionId: z.string(),
  sideA: z.object({
    modelId: z.string(),
    reasoningLevel: z.enum(["low", "medium", "high"]),
  }),
  sideB: z
    .object({
      modelId: z.string(),
      reasoningLevel: z.enum(["low", "medium", "high"]),
    })
    .nullable(),
  recommendation: z
    .object({
      recommendedModel: z.string(),
      recommendedReasoningLevel: z.enum(["low", "medium", "high"]),
      confidence: z.number().min(0).max(1),
      taskType: z.string(),
      shortReason: z.string(),
    })
    .nullable(),
  usedFallback: z.boolean(),
  fallbackReason: z.string().nullable(),
  skipReason: z.string().nullable(),
  shortReason: z.string().nullable(),
  taskType: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  expected_latency_ms: z.number().int().nonnegative(),
  upper_latency_ms: z.number().int().nonnegative(),
  estimate_quality: z.enum(["likely", "uncertain", "rough"]),
  latency_policy: z.string(),
  latency_basis: z.string(),
  historical_sample_count: z.number().int().nonnegative(),
  started_at: z.string(),
  completed_at: z.string().nullable(),
  actual_latency_ms: z.number().int().nonnegative().nullable(),
});

const routerAbSideBSchema = z.object({
  sessionId: z.string(),
  sideBText: z.string(),
  sideBLatencyMs: z.number().int().nonnegative(),
  completed_at: z.string(),
  actual_latency_ms: z.number().int().nonnegative(),
});

const routerExecutionEstimateSchema = z.object({
  runId: z.string().nullable(),
  model_id: z.string(),
  model_name: z.string(),
  reasoning_level: z.string().nullable(),
  provider_path: z.string(),
  selected_model_id: z.string(),
  recommended_model_id: z.string().nullable(),
  estimated_cost_usd: z.number().nullable(),
  expected_execution_latency_ms: z.number().int().nonnegative(),
  upper_execution_latency_ms: z.number().int().nonnegative(),
  expected_input_tokens: z.number().int().nonnegative(),
  expected_output_tokens: z.number().int().nonnegative(),
  expected_total_tokens: z.number().int().nonnegative(),
  estimate_quality: z.enum(["likely", "uncertain", "rough"]),
  started_at: z.string(),
});

const routerExecutionOutcomeSchema = z.object({
  runId: z.string().nullable(),
  actual_execution_latency_ms: z.number().int().nonnegative(),
  actual_input_tokens: z.number().int().nonnegative(),
  actual_output_tokens: z.number().int().nonnegative(),
  actual_total_tokens: z.number().int().nonnegative(),
  latency_deviation_ms: z.number().int(),
  latency_deviation_pct: z.number().nullable(),
  token_deviation_count: z.number().int(),
  token_deviation_pct: z.number().nullable(),
  latency_result: z.string(),
  token_result: z.string(),
  completed_at: z.string(),
});

export const routerAbDataSchemas: {
  "router-ab": typeof routerAbSchema;
  "router-ab-side-b": typeof routerAbSideBSchema;
  "router-execution-estimate": typeof routerExecutionEstimateSchema;
  "router-execution-outcome": typeof routerExecutionOutcomeSchema;
} = {
  "router-ab": routerAbSchema,
  "router-ab-side-b": routerAbSideBSchema,
  "router-execution-estimate": routerExecutionEstimateSchema,
  "router-execution-outcome": routerExecutionOutcomeSchema,
};

// Re-export so consumers don't need to import from `@/app/api/chat/route`.
export type { RouterAbDataParts };
