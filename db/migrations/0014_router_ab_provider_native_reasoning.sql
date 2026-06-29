-- Control Room — Provider-native reasoning-effort values
--
-- `0004_router_ab.sql` originally declared `side_a_reasoning_level`
-- and `side_b_reasoning_level` with a CHECK constraint that limited
-- them to the narrow OpenAI-style set `'low' | 'medium' | 'high'`.
-- The capability model was later generalized so the chat composer
-- can send provider-native values verbatim — Codex `xhigh` /
-- `none` / `minimal`, MiniMax `adaptive`, or any future
-- provider-native name. This migration drops the legacy CHECK
-- constraint and replaces it with a permissive one so the column
-- accepts any non-empty text.
--
-- Idempotent: drops the legacy constraint if present and replaces
-- it with the new permissive form. Existing rows keep their values;
-- the validation now lives in `lib/providers/access-control.ts`
-- (capability-aware) and `lib/router/schema.ts`
-- (router-settings save-time validator).

BEGIN;

ALTER TABLE router_ab_sessions
  DROP CONSTRAINT IF EXISTS router_ab_sessions_side_a_reasoning_level_check;

ALTER TABLE router_ab_sessions
  DROP CONSTRAINT IF EXISTS router_ab_sessions_side_b_reasoning_level_check;

ALTER TABLE router_ab_sessions
  ADD CONSTRAINT router_ab_sessions_side_a_reasoning_level_check
  CHECK (side_a_reasoning_level IS NOT NULL AND length(side_a_reasoning_level) > 0);

ALTER TABLE router_ab_sessions
  ADD CONSTRAINT router_ab_sessions_side_b_reasoning_level_check
  CHECK (
    side_b_reasoning_level IS NULL
    OR length(side_b_reasoning_level) > 0
  );

COMMIT;