ALTER TABLE router_decision_runs
  ALTER COLUMN decision DROP NOT NULL,
  ALTER COLUMN reason DROP NOT NULL;

ALTER TABLE router_decision_runs
  ADD COLUMN IF NOT EXISTS decision_source text NULL CHECK (decision_source IN ('model','manual_after_model_error')),
  ADD COLUMN IF NOT EXISTS recommender_model_id text NULL,
  ADD COLUMN IF NOT EXISTS ambiguity text NULL CHECK (ambiguity IN ('low','medium','high')),
  ADD COLUMN IF NOT EXISTS signals_json jsonb NULL,
  ADD COLUMN IF NOT EXISTS error_json jsonb NULL;
