import "server-only";

import { tryDb, withClient } from "@/lib/db";
import {
  ProviderUsageSnapshotSchema,
  type ProviderUsageSnapshot,
} from "@/lib/usage/snapshot-shape";

/**
 * Repo module for `provider_usage_snapshots`.
 *
 * Read paths use `tryDb` so a missing/unreachable DB does not break
 * the UI (the usage panel keeps rendering with the local-log
 * estimate). Write paths use `withClient` so failures surface
 * explicitly to the API layer.
 *
 * The DTO shape (`ProviderUsageSnapshot`, camelCase) is the same as
 * the one consumed by `components/assistant-ui/usage-quotas.tsx`.
 * The DB row is snake_case; `parseSnapshotRow` is the only place
 * that knows about that mapping.
 */

type RawSnapshotRow = {
  id: string;
  provider_id: string;
  provider_label: string;
  access_type: string;
  source_type: string;
  confidence: string;
  plan_name: string | null;
  short_window_label: string | null;
  short_window_used_percent: number | string | null;
  short_window_remaining_percent: number | string | null;
  short_window_reset_label: string | null;
  weekly_window_label: string | null;
  weekly_window_used_percent: number | string | null;
  weekly_window_remaining_percent: number | string | null;
  weekly_window_reset_label: string | null;
  credits_remaining: string | number | null;
  usage_at_timestamp_value: string | null;
  usage_at_timestamp_label: string | null;
  last_7_days_usage: string | null;
  last_30_days_usage: string | null;
  estimated_input_tokens: string | number | null;
  estimated_output_tokens: string | number | null;
  estimated_total_tokens: string | number | null;
  configured_limit_tokens: string | number | null;
  estimated_remaining_tokens: string | number | null;
  captured_at: Date | string;
  notes: string | null;
  screenshot_attachment_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const COLUMNS =
  "id, provider_id, provider_label, access_type, source_type, confidence, " +
  "plan_name, short_window_label, short_window_used_percent, " +
  "short_window_remaining_percent, short_window_reset_label, " +
  "weekly_window_label, weekly_window_used_percent, " +
  "weekly_window_remaining_percent, weekly_window_reset_label, " +
  "credits_remaining, usage_at_timestamp_value, usage_at_timestamp_label, " +
  "last_7_days_usage, last_30_days_usage, " +
  "estimated_input_tokens, estimated_output_tokens, estimated_total_tokens, " +
  "configured_limit_tokens, estimated_remaining_tokens, " +
  "captured_at, notes, screenshot_attachment_id, created_at, updated_at";

function toNumberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toIso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return new Date(0).toISOString();
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

export function parseSnapshotRow(raw: RawSnapshotRow): ProviderUsageSnapshot {
  const candidate = {
    id: raw.id,
    providerId: raw.provider_id,
    providerLabel: raw.provider_label,
    accessType: raw.access_type,
    sourceType: raw.source_type,
    confidence: raw.confidence,
    planName: raw.plan_name,
    shortWindowLabel: raw.short_window_label,
    shortWindowUsedPercent: toNumberOrNull(raw.short_window_used_percent),
    shortWindowRemainingPercent: toNumberOrNull(raw.short_window_remaining_percent),
    shortWindowResetLabel: raw.short_window_reset_label,
    weeklyWindowLabel: raw.weekly_window_label,
    weeklyWindowUsedPercent: toNumberOrNull(raw.weekly_window_used_percent),
    weeklyWindowRemainingPercent: toNumberOrNull(raw.weekly_window_remaining_percent),
    weeklyWindowResetLabel: raw.weekly_window_reset_label,
    creditsRemaining: toNumberOrNull(raw.credits_remaining),
    usageAtTimestampValue: raw.usage_at_timestamp_value,
    usageAtTimestampLabel: raw.usage_at_timestamp_label,
    last7DaysUsage: raw.last_7_days_usage,
    last30DaysUsage: raw.last_30_days_usage,
    estimatedInputTokens: toNumberOrNull(raw.estimated_input_tokens),
    estimatedOutputTokens: toNumberOrNull(raw.estimated_output_tokens),
    estimatedTotalTokens: toNumberOrNull(raw.estimated_total_tokens),
    configuredLimitTokens: toNumberOrNull(raw.configured_limit_tokens),
    estimatedRemainingTokens: toNumberOrNull(raw.estimated_remaining_tokens),
    capturedAt: toIso(raw.captured_at),
    notes: raw.notes,
    screenshotAttachmentId: raw.screenshot_attachment_id,
  };
  return ProviderUsageSnapshotSchema.parse(candidate);
}

export type SnapshotWriteInput = Omit<
  ProviderUsageSnapshot,
  "id" | "createdAt" | "updatedAt" | "capturedAt"
> & {
  /** Optional explicit capturedAt ISO; defaults to now(). */
  capturedAt?: string;
};

export async function insertSnapshot(input: SnapshotWriteInput): Promise<ProviderUsageSnapshot> {
  return withClient(async (c) => {
    const params = [
      input.providerId,
      input.providerLabel,
      input.accessType,
      input.sourceType,
      input.confidence,
      input.planName ?? null,
      input.shortWindowLabel ?? null,
      numericParam(input.shortWindowUsedPercent),
      numericParam(input.shortWindowRemainingPercent),
      input.shortWindowResetLabel ?? null,
      input.weeklyWindowLabel ?? null,
      numericParam(input.weeklyWindowUsedPercent),
      numericParam(input.weeklyWindowRemainingPercent),
      input.weeklyWindowResetLabel ?? null,
      numericParam(input.creditsRemaining),
      input.usageAtTimestampValue ?? null,
      input.usageAtTimestampLabel ?? null,
      input.last7DaysUsage ?? null,
      input.last30DaysUsage ?? null,
      numericParam(input.estimatedInputTokens),
      numericParam(input.estimatedOutputTokens),
      numericParam(input.estimatedTotalTokens),
      numericParam(input.configuredLimitTokens),
      numericParam(input.estimatedRemainingTokens),
      input.capturedAt ?? new Date().toISOString(),
      input.notes ?? null,
      input.screenshotAttachmentId ?? null,
    ];
    const { rows } = await c.query<RawSnapshotRow>(
      `INSERT INTO provider_usage_snapshots (
         provider_id, provider_label, access_type, source_type, confidence,
         plan_name,
         short_window_label, short_window_used_percent, short_window_remaining_percent, short_window_reset_label,
         weekly_window_label, weekly_window_used_percent, weekly_window_remaining_percent, weekly_window_reset_label,
         credits_remaining,
         usage_at_timestamp_value, usage_at_timestamp_label,
         last_7_days_usage, last_30_days_usage,
         estimated_input_tokens, estimated_output_tokens, estimated_total_tokens,
         configured_limit_tokens, estimated_remaining_tokens,
         captured_at, notes, screenshot_attachment_id
       ) VALUES (
         $1,$2,$3,$4,$5,
         $6,
         $7,$8,$9,$10,
         $11,$12,$13,$14,
         $15,
         $16,$17,
         $18,$19,
         $20,$21,$22,
         $23,$24,
         $25,$26,$27
       )
       RETURNING ${COLUMNS}`,
      params,
    );
    return parseSnapshotRow(rows[0]);
  });
}

function numericParam(value: number | null | undefined): number | string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

export type ListSnapshotsOptions = {
  providerId?: string;
  limit?: number;
};

/**
 * Read path. Falls back to an empty array on DB outage. Use
 * `latestSnapshotByProvider` or `latestSnapshotMap` for the common
 * "show one row per provider" UI rendering.
 */
export async function listSnapshots(
  options: ListSnapshotsOptions = {},
): Promise<ProviderUsageSnapshot[]> {
  const limit = clampLimit(options.limit);
  const result = await tryDb(async (c) => {
    if (options.providerId) {
      const { rows } = await c.query<RawSnapshotRow>(
        `SELECT ${COLUMNS} FROM provider_usage_snapshots
         WHERE provider_id = $1
         ORDER BY captured_at DESC
         LIMIT $2`,
        [options.providerId, limit],
      );
      return rows;
    }
    const { rows } = await c.query<RawSnapshotRow>(
      `SELECT ${COLUMNS} FROM provider_usage_snapshots
       ORDER BY captured_at DESC
       LIMIT $1`,
      [limit],
    );
    return rows;
  }, [] as RawSnapshotRow[]);
  return result.map(parseSnapshotRow);
}

function clampLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 50;
  return Math.min(Math.round(value), 200);
}

export async function latestSnapshotByProvider(
  providerId: string,
): Promise<ProviderUsageSnapshot | null> {
  const result = await tryDb(
    async (c) => {
      const { rows } = await c.query<RawSnapshotRow>(
        `SELECT ${COLUMNS} FROM provider_usage_snapshots
       WHERE provider_id = $1
       ORDER BY captured_at DESC
       LIMIT 1`,
        [providerId],
      );
      return rows[0] ?? null;
    },
    null as RawSnapshotRow | null,
  );
  return result ? parseSnapshotRow(result) : null;
}

export async function latestSnapshotMap(
  providerIds: ReadonlyArray<string>,
): Promise<Record<string, ProviderUsageSnapshot | null>> {
  const ids = providerIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  const result: Record<string, ProviderUsageSnapshot | null> = {};
  for (const id of ids) result[id] = null;
  if (ids.length === 0) return result;
  const rows = await tryDb(async (c) => {
    const { rows: r } = await c.query<RawSnapshotRow>(
      `SELECT DISTINCT ON (provider_id) ${COLUMNS} FROM provider_usage_snapshots
       WHERE provider_id = ANY($1::text[])
       ORDER BY provider_id, captured_at DESC`,
      [ids],
    );
    return r;
  }, [] as RawSnapshotRow[]);
  for (const row of rows) result[row.provider_id] = parseSnapshotRow(row);
  return result;
}

/**
 * Test-only escape hatch. Clears the table. Only used by the integration
 * test in `provider-usage-snapshots.test.ts`; do NOT call from app code.
 */
export async function __resetSnapshotsForTests(): Promise<void> {
  await withClient((c) => c.query("DELETE FROM provider_usage_snapshots"));
}
