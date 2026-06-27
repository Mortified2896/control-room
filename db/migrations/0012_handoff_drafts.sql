BEGIN;

CREATE TABLE IF NOT EXISTS handoff_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  thread_id uuid REFERENCES threads(id),
  source_message_id uuid REFERENCES messages(id),
  worker text NOT NULL,
  task_type text NOT NULL,
  title text,
  prompt text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT handoff_drafts_worker_check CHECK (worker IN ('pi', 'codex', 'opencode')),
  CONSTRAINT handoff_drafts_status_check CHECK (status IN ('draft', 'copied', 'discarded'))
);

CREATE INDEX IF NOT EXISTS handoff_drafts_thread_created_at_idx
  ON handoff_drafts (thread_id, created_at DESC);

CREATE INDEX IF NOT EXISTS handoff_drafts_project_created_at_idx
  ON handoff_drafts (project_id, created_at DESC);

DROP TRIGGER IF EXISTS handoff_drafts_set_updated_at ON handoff_drafts;
CREATE TRIGGER handoff_drafts_set_updated_at
  BEFORE UPDATE ON handoff_drafts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
