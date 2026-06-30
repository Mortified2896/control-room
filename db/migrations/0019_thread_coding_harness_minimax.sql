BEGIN;

-- Allow MiniMax CLI as a second valid coding-task harness. The
-- harness registry is the source of truth for *which* harnesses
-- are valid for a given run; this CHECK is a defensive invariant
-- so a stray row cannot smuggle in an unsupported executor id.
ALTER TABLE threads
  DROP CONSTRAINT IF EXISTS threads_harness_check;

ALTER TABLE threads
  ADD CONSTRAINT threads_harness_check
  CHECK (harness IS NULL OR harness IN ('pi', 'codex', 'opencode', 'minimax'));

COMMIT;