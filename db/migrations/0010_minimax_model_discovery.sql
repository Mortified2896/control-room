CREATE TABLE IF NOT EXISTS minimax_models_discovery (
  id integer PRIMARY KEY DEFAULT 1,
  model_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  previous_model_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at timestamptz NULL,
  http_status integer NULL,
  source text NOT NULL DEFAULT 'fallback',
  raw_count integer NOT NULL DEFAULT 0,
  error_message text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT minimax_models_discovery_singleton CHECK (id = 1),
  CONSTRAINT minimax_models_discovery_source_check CHECK (source IN ('minimax', 'fallback'))
);

INSERT INTO minimax_models_discovery (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;
