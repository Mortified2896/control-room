import "server-only";

import { withClient, tryDb } from "@/lib/db";

/**
 * Repo functions for the OpenAI model discovery cache.
 *
 * The discovery cache is a single-row table (`openai_models_discovery`,
 * id=1) that records the last successful GET /v1/models response plus the
 * last attempt's status / error. The chat path reads it via
 * `getDiscoverySnapshot()` (which uses `tryDb` and returns a safe fallback
 * on DB error), and the Settings UI writes through
 * `writeDiscoverySuccess()` / `writeDiscoveryFailure()`.
 *
 * The cache row keeps the last *successful* `model_ids` even when the
 * most recent attempt failed — the `error_message` field captures the
 * failure without wiping the recoverable payload. The `fetched_at` column
 * is the timestamp of the most recent *successful* fetch (NULL until the
 * first success).
 *
 * This module never throws on read paths. Write paths throw so the HTTP
 * layer can surface failures explicitly to the Settings UI (a refresh
 * that silently no-ops would be worse than a clear error).
 */

export const DISCOVERY_SINGLETON_ID = 1 as const;
export const DISCOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export type DiscoverySource = "openai" | "fake" | "fallback";

export type DiscoverySnapshot = {
  modelIds: ReadonlyArray<string>;
  previousModelIds: ReadonlyArray<string>;
  fetchedAt: Date | null;
  httpStatus: number | null;
  source: DiscoverySource;
  rawCount: number | null;
  errorMessage: string | null;
  updatedAt: Date | null;
};

export const EMPTY_DISCOVERY_SNAPSHOT: DiscoverySnapshot = {
  modelIds: [],
  previousModelIds: [],
  fetchedAt: null,
  httpStatus: null,
  source: "fallback",
  rawCount: 0,
  errorMessage: null,
  updatedAt: null,
};

type RawDiscoveryRow = {
  id: number;
  model_ids: unknown;
  previous_model_ids: unknown;
  fetched_at: Date | null;
  http_status: number | null;
  source: string;
  raw_count: number | null;
  error_message: string | null;
  updated_at: Date | null;
};

function isDiscoverySource(value: string): value is DiscoverySource {
  return value === "openai" || value === "fake" || value === "fallback";
}

function toSnapshot(row: RawDiscoveryRow | undefined): DiscoverySnapshot {
  if (!row) return EMPTY_DISCOVERY_SNAPSHOT;
  const ids = Array.isArray(row.model_ids)
    ? (row.model_ids as unknown[]).filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
  const previousIds = Array.isArray(row.previous_model_ids)
    ? (row.previous_model_ids as unknown[]).filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      )
    : [];
  return {
    modelIds: ids,
    previousModelIds: previousIds,
    fetchedAt: row.fetched_at,
    httpStatus: row.http_status,
    source: isDiscoverySource(row.source) ? row.source : "fallback",
    rawCount: row.raw_count,
    errorMessage: row.error_message,
    updatedAt: row.updated_at,
  };
}

/**
 * Read the current discovery snapshot. Uses `tryDb` so a missing DB /
 * missing table / transient error degrades to the empty fallback snapshot
 * instead of crashing the chat path.
 */
export async function getDiscoverySnapshot(): Promise<DiscoverySnapshot> {
  return tryDb(async (c) => {
    const { rows } = await c.query<RawDiscoveryRow>(
      `SELECT id, model_ids, previous_model_ids, fetched_at, http_status, source, raw_count, error_message, updated_at
         FROM openai_models_discovery
        WHERE id = $1`,
      [DISCOVERY_SINGLETON_ID],
    );
    return toSnapshot(rows[0]);
  }, EMPTY_DISCOVERY_SNAPSHOT);
}

/**
 * Record a successful discovery fetch. Overwrites model_ids + status,
 * promotes the prior model_ids into previous_model_ids (so the registry
 * can derive `stale`), clears the error message, and bumps `fetched_at`.
 *
 * Throws on DB error; the caller (Settings UI route handler) is expected
 * to catch and surface a clear error.
 */
export async function writeDiscoverySuccess(input: {
  modelIds: ReadonlyArray<string>;
  httpStatus: number;
  source: "openai" | "fake";
}): Promise<void> {
  // Dedupe and sort for a stable JSONB payload.
  const ids = [...new Set(input.modelIds)].sort();
  await withClient(async (c) => {
    await c.query(
      `UPDATE openai_models_discovery
          SET previous_model_ids = model_ids,
              model_ids          = $2::jsonb,
              fetched_at         = now(),
              http_status        = $3,
              source             = $4,
              raw_count          = $5,
              error_message      = NULL
        WHERE id = $1`,
      [DISCOVERY_SINGLETON_ID, JSON.stringify(ids), input.httpStatus, input.source, ids.length],
    );
  });
}

/**
 * Record a failed discovery fetch. Preserves the last successful
 * `model_ids` (so the chat path still has something to fall back to) but
 * captures the failure in `error_message` and `http_status`. Cleared on
 * the next successful fetch.
 *
 * Throws on DB error.
 */
export async function writeDiscoveryFailure(input: {
  errorMessage: string;
  httpStatus: number | null;
  source: "openai" | "fake";
}): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `UPDATE openai_models_discovery
          SET http_status   = $2,
              source        = $3,
              error_message = $4
        WHERE id = $1`,
      [DISCOVERY_SINGLETON_ID, input.httpStatus, input.source, input.errorMessage.slice(0, 2000)],
    );
  });
}

/**
 * Test-only: clear the discovery cache back to the empty fallback snapshot.
 * Used by tests that need a clean slate between runs.
 */
export async function __resetDiscoveryForTests(): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `UPDATE openai_models_discovery
          SET model_ids          = '[]'::jsonb,
              previous_model_ids = '[]'::jsonb,
              fetched_at         = NULL,
              http_status        = NULL,
              source             = 'fallback',
              raw_count          = 0,
              error_message      = NULL
        WHERE id = $1`,
      [DISCOVERY_SINGLETON_ID],
    );
  });
}
