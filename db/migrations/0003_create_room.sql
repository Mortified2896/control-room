BEGIN;

CREATE TABLE IF NOT EXISTS create_room_episodes (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id                  uuid        NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE,
  episode_code               text        NOT NULL UNIQUE,
  working_title              text,
  workflow_step              text        NOT NULL DEFAULT 'idea_vocab'
    CHECK (workflow_step IN ('idea_vocab', 'title', 'thumbnail', 'outline', 'script', 'review', 'ready', 'published')),
  selected_idea              text,
  target_learner_level       text,
  selected_title             text,
  selected_thumbnail_concept text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS create_room_episodes_workflow_updated_idx
  ON create_room_episodes (workflow_step, updated_at DESC);

CREATE TABLE IF NOT EXISTS create_room_candidates (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id   uuid        NOT NULL REFERENCES create_room_episodes(id) ON DELETE CASCADE,
  type         text        NOT NULL CHECK (type IN ('idea_vocab', 'title', 'thumbnail')),
  payload_json jsonb       NOT NULL,
  status       text        NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'selected', 'rejected', 'archived')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS create_room_candidates_episode_type_created_idx
  ON create_room_candidates (episode_id, type, created_at DESC);

CREATE TABLE IF NOT EXISTS create_room_decisions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id    uuid        NOT NULL REFERENCES create_room_episodes(id) ON DELETE CASCADE,
  decision_type text        NOT NULL,
  candidate_id  uuid        REFERENCES create_room_candidates(id) ON DELETE SET NULL,
  payload_json  jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS create_room_decisions_episode_created_idx
  ON create_room_decisions (episode_id, created_at DESC);

DROP TRIGGER IF EXISTS create_room_episodes_set_updated_at ON create_room_episodes;
CREATE TRIGGER create_room_episodes_set_updated_at
  BEFORE UPDATE ON create_room_episodes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS create_room_candidates_set_updated_at ON create_room_candidates;
CREATE TRIGGER create_room_candidates_set_updated_at
  BEFORE UPDATE ON create_room_candidates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
