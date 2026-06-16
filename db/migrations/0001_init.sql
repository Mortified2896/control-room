-- Control Room — initial schema
--
-- Mirrors the Phase 2 spec in `docs/POSTGRES_PLAN.md` (Milestone 2), with
-- the feedback column as `rating text` ('up' | 'down') per the Phase 2 brief.
--
-- Idempotent: uses IF NOT EXISTS where possible and a `CREATE OR REPLACE`
-- function for the updated_at trigger. Safe to re-run; the runner script
-- applies this file once per migration and tracks applied filenames in
-- `schema_migrations`.
--
-- Requires: `pgcrypto` for `gen_random_uuid()` (Postgres 13+ ships it, but
-- we still `CREATE EXTENSION IF NOT EXISTS` so older / minimal installs
-- work too).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS threads (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text        NOT NULL,
  model_id    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id   uuid        NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role        text        NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content     text,
  parts       jsonb,
  model_id    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_thread_id_created_at_idx
  ON messages (thread_id, created_at);

CREATE TABLE IF NOT EXISTS message_feedback (
  message_id  uuid        PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  rating      text        NOT NULL CHECK (rating IN ('up', 'down')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Reusable updated_at touch trigger
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS threads_set_updated_at ON threads;
CREATE TRIGGER threads_set_updated_at
  BEFORE UPDATE ON threads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS message_feedback_set_updated_at ON message_feedback;
CREATE TRIGGER message_feedback_set_updated_at
  BEFORE UPDATE ON message_feedback
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
