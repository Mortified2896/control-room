BEGIN;

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  local_path text NOT NULL UNIQUE,
  git_remote_url text,
  git_branch text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_opened_at timestamptz
);

ALTER TABLE threads
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id);

CREATE INDEX IF NOT EXISTS threads_project_id_updated_at_idx
  ON threads (project_id, updated_at DESC);

DROP TRIGGER IF EXISTS projects_set_updated_at ON projects;
CREATE TRIGGER projects_set_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
