-- Control Room — Router settings singleton row.
--
-- The Router A/B mode uses a small bag of safety/budget knobs (allowlist,
-- fallback combo, expensive-tier toggle, long-prompt threshold, etc.) that
-- previously were env-var-only. This migration adds a single-row settings
-- table that the Settings UI writes to and the chat route reads on every
-- request.
--
-- Design notes:
--   - We use a singleton-row pattern (id integer PRIMARY KEY DEFAULT 1,
--     CHECK (id = 1)) instead of a free-form settings table because there
--     is exactly one settings object in this app and the UI always edits
--     the whole payload atomically.
--   - The full validated payload is stored as JSONB so the UI can ship a
--     round-trip-safe representation. The chat route never reads this
--     column directly — it goes through `lib/repo/router-settings.ts` and
--     `lib/router/settings-store.ts` which validate + merge with env
--     defaults.
--   - `updated_at` is touched on every update by the existing trigger
--     function installed in 0001_init.sql.
--   - `schema_version` is bumped in lockstep with the JSON shape consumed
--     by `lib/router/schema.ts`. If you change the settings shape in an
--     incompatible way, bump this and add a migration that rewrites the
--     stored payload to the new shape.

BEGIN;

CREATE TABLE IF NOT EXISTS router_settings (
  id             integer     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  settings       jsonb       NOT NULL,
  schema_version integer     NOT NULL DEFAULT 1,
  updated_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Insert the singleton row with the default payload so the very first
-- read after migration succeeds even before the UI has ever been opened.
INSERT INTO router_settings (id, settings, schema_version)
VALUES (1, '{}'::jsonb, 1)
ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS router_settings_set_updated_at ON router_settings;
CREATE TRIGGER router_settings_set_updated_at
  BEFORE UPDATE ON router_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
