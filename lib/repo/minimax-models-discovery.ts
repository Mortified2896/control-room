import "server-only";

import { tryDb, withClient } from "@/lib/db";

export const MINIMAX_DISCOVERY_SINGLETON_ID = 1 as const;
export const MINIMAX_DISCOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export type MiniMaxDiscoverySource = "minimax" | "fallback";

export type MiniMaxDiscoverySnapshot = {
  modelIds: ReadonlyArray<string>;
  previousModelIds: ReadonlyArray<string>;
  fetchedAt: Date | null;
  httpStatus: number | null;
  source: MiniMaxDiscoverySource;
  rawCount: number | null;
  errorMessage: string | null;
  updatedAt: Date | null;
};

export const EMPTY_MINIMAX_DISCOVERY_SNAPSHOT: MiniMaxDiscoverySnapshot = {
  modelIds: [],
  previousModelIds: [],
  fetchedAt: null,
  httpStatus: null,
  source: "fallback",
  rawCount: 0,
  errorMessage: null,
  updatedAt: null,
};

type RawRow = {
  model_ids: unknown;
  previous_model_ids: unknown;
  fetched_at: Date | null;
  http_status: number | null;
  source: string;
  raw_count: number | null;
  error_message: string | null;
  updated_at: Date | null;
};

function ids(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
}

function toSnapshot(row: RawRow | undefined): MiniMaxDiscoverySnapshot {
  if (!row) return EMPTY_MINIMAX_DISCOVERY_SNAPSHOT;
  return {
    modelIds: ids(row.model_ids),
    previousModelIds: ids(row.previous_model_ids),
    fetchedAt: row.fetched_at,
    httpStatus: row.http_status,
    source: row.source === "minimax" ? "minimax" : "fallback",
    rawCount: row.raw_count,
    errorMessage: row.error_message,
    updatedAt: row.updated_at,
  };
}

export async function getMiniMaxDiscoverySnapshot(): Promise<MiniMaxDiscoverySnapshot> {
  return tryDb(async (c) => {
    const { rows } = await c.query<RawRow>(
      `SELECT model_ids, previous_model_ids, fetched_at, http_status, source, raw_count, error_message, updated_at
         FROM minimax_models_discovery
        WHERE id = $1`,
      [MINIMAX_DISCOVERY_SINGLETON_ID],
    );
    return toSnapshot(rows[0]);
  }, EMPTY_MINIMAX_DISCOVERY_SNAPSHOT);
}

export async function writeMiniMaxDiscoverySuccess(input: {
  modelIds: ReadonlyArray<string>;
  httpStatus: number;
}): Promise<void> {
  const modelIds = [...new Set(input.modelIds)].sort();
  await withClient(async (c) => {
    await c.query(
      `UPDATE minimax_models_discovery
          SET previous_model_ids = model_ids,
              model_ids          = $2::jsonb,
              fetched_at         = now(),
              http_status        = $3,
              source             = 'minimax',
              raw_count          = $4,
              error_message      = NULL,
              updated_at         = now()
        WHERE id = $1`,
      [MINIMAX_DISCOVERY_SINGLETON_ID, JSON.stringify(modelIds), input.httpStatus, modelIds.length],
    );
  });
}

export async function writeMiniMaxDiscoveryFailure(input: {
  errorMessage: string;
  httpStatus: number | null;
}): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `UPDATE minimax_models_discovery
          SET http_status   = $2,
              source        = 'minimax',
              error_message = $3,
              updated_at    = now()
        WHERE id = $1`,
      [MINIMAX_DISCOVERY_SINGLETON_ID, input.httpStatus, input.errorMessage.slice(0, 2000)],
    );
  });
}
