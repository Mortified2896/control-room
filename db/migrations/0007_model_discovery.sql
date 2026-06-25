-- Control Room — OpenAI model discovery cache + manual selector visibility.
--
-- Two new singleton rows (id=1, CHECK constraint) that back the
-- dynamic-model-discovery feature added in this migration:
--
--   openai_models_discovery
--     Last successful GET /v1/models payload from OpenAI. Refreshed on
--     demand from /settings/router or automatically when the cache is
--     older than 24h (only triggered by the Settings UI route, never on
--     chat requests — see lib/providers/openai-discovery.ts).
--
--     `model_ids` is the list of model ids returned by the API. The full
--     raw payload is intentionally not preserved here: the chat path only
--     needs the id set to know which models are available to the API key.
--
--     `source` records whether the cached payload came from a real OpenAI
--     call ("openai"), the dev/Playwright fake ("fake"), or the legacy
--     static fallback ("fallback", the empty default row).
--
--     `error_message` is populated when the most recent fetch attempt
--     failed. `http_status` captures the last response status (or NULL on
--     network-level failure). The cache row keeps the last *successful*
--     model_ids even when the most recent attempt failed, so the chat
--     path always has something to fall back to.
--
--   model_selector_prefs
--     Per-model show/hide preferences for the manual chat model selector.
--     Decoupled from `router_settings.allowedCombos` per the brief: the
--     manual selector and the router pool are independent knobs and the
--     UI must never accidentally couple them.
--
--     Shape:
--       { "gpt-5.4-mini":       { "visible": true },
--         "gpt-5.5":            { "visible": false },
--         "gpt-unknown-fake":   { "visible": false } }
--
--     Missing entries default to "visible" for known + available models
--     and "hidden" for unknown / stale models. The default-row insert
--     here is the empty object; the runtime defaults live in
--     `lib/providers/registry.ts` so the schema and the merge layer stay
--     loosely coupled.
--
-- Why two new tables instead of augmenting `router_settings`:
--   - The discovery cache has its own lifecycle (24h TTL, refreshable).
--     Bundling it into the router settings blob would force every router
--     settings read to also revalidate the cache, and would make the
--     "settings UI wrote, but discovery cache stale" race harder to reason
--     about.
--   - The manual selector prefs are explicitly decoupled from the router
--     pool per the brief, so storing them in different tables makes the
--     decoupling structural instead of merely conventional.
--
-- Idempotent: uses IF NOT EXISTS and the existing `set_updated_at()`
-- trigger function installed in 0001_init.sql. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS openai_models_discovery (
  id                 integer     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  model_ids          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  previous_model_ids jsonb       NOT NULL DEFAULT '[]'::jsonb,
  fetched_at         timestamptz,
  http_status        integer,
  source             text        NOT NULL DEFAULT 'fallback'
                                   CHECK (source IN ('openai', 'fake', 'fallback')),
  raw_count          integer,
  error_message      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

INSERT INTO openai_models_discovery (id, model_ids, previous_model_ids, source)
VALUES (1, '[]'::jsonb, '[]'::jsonb, 'fallback')
ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS openai_models_discovery_set_updated_at ON openai_models_discovery;
CREATE TRIGGER openai_models_discovery_set_updated_at
  BEFORE UPDATE ON openai_models_discovery
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS model_selector_prefs (
  id             integer     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  preferences    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  schema_version integer     NOT NULL DEFAULT 1,
  updated_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

INSERT INTO model_selector_prefs (id, preferences)
VALUES (1, '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS model_selector_prefs_set_updated_at ON model_selector_prefs;
CREATE TRIGGER model_selector_prefs_set_updated_at
  BEFORE UPDATE ON model_selector_prefs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
