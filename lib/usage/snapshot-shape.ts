/**
 * Shared shape + zod schemas for `ProviderUsageSnapshot`.
 *
 * Lives in `lib/usage/` (not `lib/repo/`) so that the client-side
 * `usage-quotas.tsx` component can import the DTO type without dragging
 * `import "server-only"` from `lib/db.ts`. The zod schemas are pure
 * data and safe to use on both sides.
 *
 * The persistence shape lives in `db/migrations/0022_provider_usage_snapshots.sql`.
 * This module is the source of truth for the canonical DTO that both
 * the UI and the server speak; the repo module is responsible for
 * mapping it to/from the database rows.
 */

import { z } from "zod/v4";

export const PROVIDER_IDS = ["minimax", "codex", "openai"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const ACCESS_TYPES = ["subscription", "api", "local", "unknown"] as const;
export type AccessType = (typeof ACCESS_TYPES)[number];

export const SOURCE_TYPES = [
  "manual_screenshot",
  "manual_entry",
  "local_estimate",
  "official_provider_api",
  "unknown",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const CONFIDENCE_LEVELS = ["exact", "observed", "estimated", "unknown"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/** Display labels for subscription providers in the manual update flow. */
export const PROVIDER_DISPLAY: Readonly<Record<string, string>> = {
  minimax: "MiniMax subscription",
  codex: "Codex subscription",
  openai: "OpenAI API",
};

const nullableString = z.union([z.string(), z.null()]).optional();
const nullableInt = z.union([z.number().int().min(0).max(100), z.null()]).optional();
const nullableBigInt = z.union([z.number().int().nonnegative(), z.null()]).optional();
const nullableNumber = z.union([z.number(), z.null()]).optional();

/**
 * Schema for a `ProviderUsageSnapshot` exactly as persisted. The repo
 * module returns the same shape from `listSnapshots` /
 * `latestSnapshotByProvider` etc.
 *
 * `id` is null for candidates (returned from the extract endpoint)
 * and a UUID string for persisted rows.
 */
export const ProviderUsageSnapshotSchema = z.object({
  id: z.union([z.string(), z.null()]).optional(),
  providerId: z.enum(PROVIDER_IDS),
  providerLabel: z.string().min(1),
  accessType: z.enum(ACCESS_TYPES),
  sourceType: z.enum(SOURCE_TYPES),
  confidence: z.enum(CONFIDENCE_LEVELS),

  planName: nullableString,

  shortWindowLabel: nullableString,
  shortWindowUsedPercent: nullableInt,
  shortWindowRemainingPercent: nullableInt,
  shortWindowResetLabel: nullableString,

  weeklyWindowLabel: nullableString,
  weeklyWindowUsedPercent: nullableInt,
  weeklyWindowRemainingPercent: nullableInt,
  weeklyWindowResetLabel: nullableString,

  creditsRemaining: nullableNumber,

  usageAtTimestampValue: nullableString,
  usageAtTimestampLabel: nullableString,
  last7DaysUsage: nullableString,
  last30DaysUsage: nullableString,

  estimatedInputTokens: nullableBigInt,
  estimatedOutputTokens: nullableBigInt,
  estimatedTotalTokens: nullableBigInt,
  configuredLimitTokens: nullableBigInt,
  estimatedRemainingTokens: nullableBigInt,

  capturedAt: z.string(),
  notes: nullableString,
  screenshotAttachmentId: nullableString,
});

export type ProviderUsageSnapshot = z.infer<typeof ProviderUsageSnapshotSchema>;

/** A candidate shell returned from `/api/usage/screenshot/extract`. */
export const EMPTY_CANDIDATE: ProviderUsageSnapshot = {
  id: null,
  providerId: "minimax",
  providerLabel: PROVIDER_DISPLAY.minimax,
  accessType: "subscription",
  sourceType: "manual_screenshot",
  confidence: "unknown",
  planName: null,
  shortWindowLabel: null,
  shortWindowUsedPercent: null,
  shortWindowRemainingPercent: null,
  shortWindowResetLabel: null,
  weeklyWindowLabel: null,
  weeklyWindowUsedPercent: null,
  weeklyWindowRemainingPercent: null,
  weeklyWindowResetLabel: null,
  creditsRemaining: null,
  usageAtTimestampValue: null,
  usageAtTimestampLabel: null,
  last7DaysUsage: null,
  last30DaysUsage: null,
  estimatedInputTokens: null,
  estimatedOutputTokens: null,
  estimatedTotalTokens: null,
  configuredLimitTokens: null,
  estimatedRemainingTokens: null,
  capturedAt: "1970-01-01T00:00:00.000Z",
  notes: null,
  screenshotAttachmentId: null,
};

export type ValidationError = { path: string; message: string };
