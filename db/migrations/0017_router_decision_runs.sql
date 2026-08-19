CREATE TABLE IF NOT EXISTS router_decision_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NULL,
  project_id uuid NULL,
  prompt_hash text NOT NULL,
  prompt_text text NULL,
  decision text NOT NULL CHECK (decision IN ('normal_chat','coding_task')),
  reason text NOT NULL,
  estimate_quality text NOT NULL CHECK (estimate_quality IN ('likely','uncertain','rough')),
  expected_latency_ms integer NOT NULL,
  upper_latency_ms integer NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  actual_latency_ms integer NOT NULL,
  latency_deviation_ms integer NOT NULL,
  latency_deviation_pct double precision NULL,
  user_action text NULL CHECK (user_action IN ('approved','corrected_to_coding_task','corrected_to_normal_chat','canceled')),
  user_comment text NULL,
  final_decision text NULL CHECK (final_decision IN ('normal_chat','coding_task')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS router_decision_runs_prompt_idx
  ON router_decision_runs (prompt_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS router_decision_runs_thread_idx
  ON router_decision_runs (thread_id, created_at DESC);
