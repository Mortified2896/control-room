BEGIN;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS repo_path text;

UPDATE projects
SET repo_path = local_path
WHERE repo_path IS NULL;

ALTER TABLE projects
  ALTER COLUMN repo_path SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS projects_repo_path_key ON projects (repo_path);

INSERT INTO projects (name, local_path, repo_path, last_opened_at)
VALUES ('control-room', '/home/hermes/workspace/repos/control-room', '/home/hermes/workspace/repos/control-room', now())
ON CONFLICT (local_path) DO UPDATE SET
  name = EXCLUDED.name,
  repo_path = EXCLUDED.repo_path,
  last_opened_at = now();

CREATE TABLE IF NOT EXISTS coding_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id uuid REFERENCES threads(id) ON DELETE SET NULL,
  prompt text NOT NULL,
  executor text NOT NULL DEFAULT 'codex-cli',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  stdout text NOT NULL DEFAULT '',
  stderr text NOT NULL DEFAULT '',
  exit_code integer,
  git_status_short text NOT NULL DEFAULT '',
  git_diff_stat text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS coding_runs_project_created_at_idx
  ON coding_runs (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS coding_runs_thread_created_at_idx
  ON coding_runs (thread_id, created_at DESC) WHERE thread_id IS NOT NULL;

COMMIT;
