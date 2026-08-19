ALTER TABLE threads
  ADD COLUMN IF NOT EXISTS thread_mode text DEFAULT 'chat',
  ADD COLUMN IF NOT EXISTS harness text;

ALTER TABLE threads
  DROP CONSTRAINT IF EXISTS threads_thread_mode_check,
  ADD CONSTRAINT threads_thread_mode_check CHECK (thread_mode IS NULL OR thread_mode IN ('chat', 'coding_task'));

ALTER TABLE threads
  DROP CONSTRAINT IF EXISTS threads_harness_check,
  ADD CONSTRAINT threads_harness_check CHECK (harness IS NULL OR harness IN ('pi', 'codex', 'opencode'));

UPDATE threads SET thread_mode = 'chat' WHERE thread_mode IS NULL;
