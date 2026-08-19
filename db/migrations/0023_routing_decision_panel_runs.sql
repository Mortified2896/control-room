-- New table for the Routing Decision Panel telemetry.
--
-- The brief asks for an additive migration: the existing
-- `router_decision_runs` table is preserved so the legacy
-- `/api/router/decision` flow keeps working unchanged. This new
-- table captures the FULL panel payload (the original
-- recommendation + the user's final selection + the diff + the
-- optional free-text comment) so future dashboards can measure
-- correction rates per field and surface common correction
-- comments.
--
-- `panel` is the original recommendation snapshot the route
-- sent to the client (jsonb).
-- `selection` is the user's final pick at send time (jsonb).
-- `changed_fields` is the JSON array of edited field keys.
-- `comment` is the optional free-text annotation (≤ 1000 chars
-- at the application layer; the column has no hard length cap
-- to keep the migration additive — the route handler enforces
-- the cap).
--
-- `recommendation_run_id` is a soft link to the existing
-- `router_recommendation_runs` row so an analyst can join the
-- panel-level KPI data with the model-pick telemetry that
-- produced the recommendation. `on delete set null` so a
-- recommendation cleanup does not orphan the panel records.
CREATE TABLE IF NOT EXISTS routing_decision_panel_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NULL,
  project_id uuid NULL,
  prompt_hash text NOT NULL,
  prompt_text text NULL,
  panel jsonb NOT NULL,
  selection jsonb NOT NULL,
  changed_fields jsonb NOT NULL,
  comment text NULL,
  recommendation_run_id uuid NULL REFERENCES router_recommendation_runs(id) ON DELETE SET NULL,
  confidence double precision NULL,
  cost_tier text NULL CHECK (cost_tier IN ('standard','expensive','cheap')),
  latency_ms integer NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS routing_decision_panel_runs_thread_idx
  ON routing_decision_panel_runs (thread_id, created_at DESC);

CREATE INDEX IF NOT EXISTS routing_decision_panel_runs_prompt_idx
  ON routing_decision_panel_runs (prompt_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS routing_decision_panel_runs_cost_tier_idx
  ON routing_decision_panel_runs (cost_tier, created_at DESC);

-- updated_at trigger so `updateFullRoutingDecisionRun` bumps
-- `updated_at = now()` on every patch without an explicit set
-- in the SQL.
DROP TRIGGER IF EXISTS routing_decision_panel_runs_set_updated_at ON routing_decision_panel_runs;
CREATE TRIGGER routing_decision_panel_runs_set_updated_at
  BEFORE UPDATE ON routing_decision_panel_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();