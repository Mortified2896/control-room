-- Control Room — independent thread-level notes
--
-- Notes are user-authored metadata. They are intentionally separate from
-- message_feedback and messages, and must not be included in /api/chat model
-- context unless a future explicit user-controlled feature opts in.

BEGIN;

CREATE TABLE IF NOT EXISTS thread_notes (
  thread_id  uuid        PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  body       text        NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS thread_notes_set_updated_at ON thread_notes;
CREATE TRIGGER thread_notes_set_updated_at
  BEFORE UPDATE ON thread_notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
