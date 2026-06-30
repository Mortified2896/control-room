CREATE TABLE IF NOT EXISTS router_recommendation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NULL,
  episode_id uuid NULL,
  step_id text NOT NULL,
  recommender_model_id text NOT NULL,
  provider_path text NOT NULL,
  prompt_hash text NOT NULL,
  prompt_token_estimate integer NOT NULL,
  telemetry_context_token_estimate integer NOT NULL DEFAULT 0,
  expected_latency_ms integer NOT NULL,
  upper_latency_ms integer NOT NULL,
  estimate_quality text NOT NULL CHECK (estimate_quality IN ('likely','uncertain','rough')),
  latency_policy text NOT NULL,
  latency_basis text NOT NULL,
  historical_sample_count integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NULL,
  actual_latency_ms integer NULL,
  latency_deviation_ms integer NULL,
  latency_deviation_pct double precision NULL,
  latency_result text NULL,
  recommended_model_id text NULL,
  alternatives_json jsonb NULL,
  reasoning text NULL,
  fallback_used boolean NOT NULL DEFAULT false,
  error_json jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS router_recommendation_runs_hist_idx
  ON router_recommendation_runs (recommender_model_id, step_id, prompt_token_estimate, actual_latency_ms)
  WHERE actual_latency_ms IS NOT NULL;

CREATE TABLE IF NOT EXISTS router_execution_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_run_id uuid NULL REFERENCES router_recommendation_runs(id) ON DELETE SET NULL,
  workflow_run_id uuid NULL,
  episode_id uuid NULL,
  step_id text NOT NULL,
  selected_model_id text NOT NULL,
  provider_path text NOT NULL,
  prompt_hash text NOT NULL,
  prompt_token_estimate integer NOT NULL,
  context_token_estimate integer NOT NULL DEFAULT 0,
  expected_input_tokens integer NOT NULL,
  expected_output_tokens integer NOT NULL,
  expected_total_tokens integer NOT NULL,
  actual_input_tokens integer NULL,
  actual_output_tokens integer NULL,
  actual_total_tokens integer NULL,
  expected_execution_latency_ms integer NOT NULL,
  upper_execution_latency_ms integer NOT NULL,
  actual_execution_latency_ms integer NULL,
  latency_deviation_ms integer NULL,
  latency_deviation_pct double precision NULL,
  token_deviation_count integer NULL,
  token_deviation_pct double precision NULL,
  execution_estimate_quality text NOT NULL CHECK (execution_estimate_quality IN ('likely','uncertain','rough')),
  latency_result text NULL,
  token_result text NULL,
  estimated_cost_usd numeric(12,6) NULL,
  actual_cost_usd numeric(12,6) NULL,
  cost_deviation_usd numeric(12,6) NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NULL,
  success boolean NULL,
  error_json jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS router_execution_runs_hist_idx
  ON router_execution_runs (selected_model_id, step_id, prompt_token_estimate, actual_execution_latency_ms)
  WHERE actual_execution_latency_ms IS NOT NULL;
