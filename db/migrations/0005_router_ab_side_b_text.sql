-- Control Room — store Side B output text for panel re-hydration.
--
-- The router A/B MVP emits a `data-router-ab` and `data-router-ab-side-b`
-- stream part during the live chat response. When the user reloads the page,
-- the panel re-hydrates from `GET /api/router-ab/session/[id]` and needs the
-- Side B text — which only Postgres can persist (the live stream is gone).
--
-- Two new columns:
--   side_b_text         — the full assistant text Side B produced (nullable
--                          because Side B can be skipped)
--   side_b_latency_ms   — how long Side B took from kick-off to finish
--
-- The trigger already installed in 0004 keeps `updated_at` current.

BEGIN;

ALTER TABLE router_ab_sessions
  ADD COLUMN IF NOT EXISTS side_b_text        text,
  ADD COLUMN IF NOT EXISTS side_b_latency_ms  integer;

COMMIT;