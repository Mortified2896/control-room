-- Control Room — add `previous_model_ids` to `openai_models_discovery`.
--
-- Adds a column that records the model_ids from the *prior* successful
-- refresh, so the registry layer can compute `stale` (was in the last
-- successful discovery, but absent from the current one) without keeping
-- a separate history table.
--
-- Idempotent: uses ADD COLUMN IF NOT EXISTS so re-running this file is a
-- no-op. Safe because the column was missing from 0007_model_discovery.sql
-- when first applied; subsequent applications get the column backfilled
-- to the empty array.

BEGIN;

ALTER TABLE openai_models_discovery
  ADD COLUMN IF NOT EXISTS previous_model_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
