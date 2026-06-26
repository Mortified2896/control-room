CREATE TABLE IF NOT EXISTS provider_access_settings (
  provider_id text PRIMARY KEY,
  enabled boolean NOT NULL,
  allow_manual boolean NOT NULL,
  allow_router boolean NOT NULL,
  allow_backend_test boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_access_settings_provider_id_check CHECK (
    provider_id IN ('codex_subscription', 'openai_api', 'minimax_api')
  )
);
