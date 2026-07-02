-- Control Room — manually-captured provider usage snapshots.
--
-- One row per confirmed snapshot. The screenshot itself is NOT stored; only
-- the extracted, user-confirmed values. This table is the authoritative
-- read-side overlay on top of the local-log estimate returned by
-- /api/usage/quotas, and the source of truth for the top-bar compact
-- summary when a snapshot exists.
--
-- Hard rules:
--   * No provider quota APIs are called. The user always confirms the
--     values before any row lands here (see POST /api/usage/snapshots).
--   * `confidence` records how trustworthy the snapshot row is:
--     `observed` for screenshot/manual entry, `exact` only when the
--     provider exposes a programmatic readout.
--   * The `access_type` column mirrors `UsageQuotaProvider.accessType` so
--     the read path can join snapshots onto provider rows without an
--     additional join table.
--   * `screenshot_attachment_id` is reserved for future image storage; no
--     attachment table ships in this migration, but the column is reserved
--     so a follow-up storage migration does not require an ALTER TABLE.
--
-- Idempotent: uses IF NOT EXISTS and the existing `set_updated_at()`
-- trigger function installed in 0001_init.sql. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS provider_usage_snapshots (
  id                              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id                     text        NOT NULL CHECK (provider_id IN ('minimax', 'codex', 'openai')),
  provider_label                  text        NOT NULL,
  access_type                     text        NOT NULL CHECK (access_type IN ('subscription','api','local','unknown')),
  source_type                     text        NOT NULL CHECK (source_type IN ('manual_screenshot','manual_entry','local_estimate','official_provider_api','unknown')),
  confidence                      text        NOT NULL CHECK (confidence IN ('exact','observed','estimated','unknown')),

  plan_name                       text        NULL,

  short_window_label              text        NULL,
  short_window_used_percent       integer     NULL CHECK (short_window_used_percent IS NULL OR (short_window_used_percent BETWEEN 0 AND 100)),
  short_window_remaining_percent  integer     NULL CHECK (short_window_remaining_percent IS NULL OR (short_window_remaining_percent BETWEEN 0 AND 100)),
  short_window_reset_label        text        NULL,

  weekly_window_label             text        NULL,
  weekly_window_used_percent      integer     NULL CHECK (weekly_window_used_percent IS NULL OR (weekly_window_used_percent BETWEEN 0 AND 100)),
  weekly_window_remaining_percent integer     NULL CHECK (weekly_window_remaining_percent IS NULL OR (weekly_window_remaining_percent BETWEEN 0 AND 100)),
  weekly_window_reset_label       text        NULL,

  credits_remaining               numeric     NULL,

  usage_at_timestamp_value        text        NULL,
  usage_at_timestamp_label        text        NULL,
  last_7_days_usage               text        NULL,
  last_30_days_usage              text        NULL,

  estimated_input_tokens          bigint      NULL,
  estimated_output_tokens         bigint      NULL,
  estimated_total_tokens          bigint      NULL,
  configured_limit_tokens         bigint      NULL,
  estimated_remaining_tokens      bigint      NULL,

  captured_at                     timestamptz NOT NULL DEFAULT now(),
  notes                           text        NULL,
  screenshot_attachment_id        uuid        NULL,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);

-- Hot read path: latest snapshot per provider.
CREATE INDEX IF NOT EXISTS provider_usage_snapshots_provider_captured_at_idx
  ON provider_usage_snapshots (provider_id, captured_at DESC);

DROP TRIGGER IF EXISTS provider_usage_snapshots_set_updated_at ON provider_usage_snapshots;
CREATE TRIGGER provider_usage_snapshots_set_updated_at
  BEFORE UPDATE ON provider_usage_snapshots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;