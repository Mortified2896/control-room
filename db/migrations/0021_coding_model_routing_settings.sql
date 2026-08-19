-- Control Room — persisted coding harness model routing settings.

BEGIN;

CREATE TABLE IF NOT EXISTS coding_model_routing_settings (
  id             integer     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  settings       jsonb       NOT NULL,
  schema_version integer     NOT NULL DEFAULT 1,
  updated_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS coding_model_routing_settings_set_updated_at ON coding_model_routing_settings;
CREATE TRIGGER coding_model_routing_settings_set_updated_at
  BEFORE UPDATE ON coding_model_routing_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
