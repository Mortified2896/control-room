-- Control Room — Router A/B mode persistence (MVP)
--
-- Each user prompt that runs through the router creates a single row in
-- `router_ab_sessions`. Side A and Side B (if generated) are described on
-- that row. Per-session feedback (Prefer A / Prefer B / Tie / Bad router)
-- is a separate one-row-per-session table so toggles are clean.
--
-- Privacy:
-- - `user_prompt_text` is stored verbatim so we can correlate feedback with
--   the actual prompt in the MVP. The chat route keeps this column populated
--   only when the thread has a corresponding row in `messages`; ad-hoc
--   /api/chat calls without a persisted thread write a short synthetic label
--   (see lib/repo/router-ab.ts).
-- - No thread notes, message_feedback, or other metadata is copied here.
--
-- Idempotent: uses IF NOT EXISTS and a `CREATE OR REPLACE` trigger function
-- (already installed by 0001_init.sql).

BEGIN;

CREATE TABLE IF NOT EXISTS router_ab_sessions (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id                uuid        NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_message_id          uuid        REFERENCES messages(id) ON DELETE SET NULL,
  assistant_message_id     uuid        REFERENCES messages(id) ON DELETE SET NULL,
  side_a_model_id          text        NOT NULL,
  side_a_reasoning_level   text        NOT NULL CHECK (side_a_reasoning_level IN ('low','medium','high')),
  side_b_model_id          text,
  side_b_reasoning_level   text        CHECK (side_b_reasoning_level IS NULL OR side_b_reasoning_level IN ('low','medium','high')),
  task_type                text        CHECK (task_type IS NULL OR task_type IN ('simple_chat','coding','debugging','writing','research','analysis','planning','other')),
  confidence               numeric(3,2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  short_reason             text,
  used_fallback            boolean     NOT NULL DEFAULT false,
  fallback_reason          text,
  skip_reason              text,
  cost_estimate_usd        numeric(8,4),
  user_prompt_text         text        NOT NULL,
  recent_chars             integer     NOT NULL DEFAULT 0,
  pool_key_hash            text,
  router_model_id          text        NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS router_ab_sessions_thread_created_idx
  ON router_ab_sessions (thread_id, created_at DESC);

CREATE INDEX IF NOT EXISTS router_ab_sessions_assistant_message_id_idx
  ON router_ab_sessions (assistant_message_id);

CREATE INDEX IF NOT EXISTS router_ab_sessions_user_message_id_idx
  ON router_ab_sessions (user_message_id);

CREATE TABLE IF NOT EXISTS router_ab_feedback (
  ab_session_id  uuid        PRIMARY KEY REFERENCES router_ab_sessions(id) ON DELETE CASCADE,
  rating         text        NOT NULL CHECK (rating IN ('prefer_a','prefer_b','tie','bad_router')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS router_ab_sessions_set_updated_at ON router_ab_sessions;
CREATE TRIGGER router_ab_sessions_set_updated_at
  BEFORE UPDATE ON router_ab_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS router_ab_feedback_set_updated_at ON router_ab_feedback;
CREATE TRIGGER router_ab_feedback_set_updated_at
  BEFORE UPDATE ON router_ab_feedback
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;