import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod/v4";
import { isDbConfigured } from "@/lib/db";
import {
  insertSnapshot,
  latestSnapshotByProvider,
  listSnapshots,
  type SnapshotWriteInput,
} from "@/lib/repo/provider-usage-snapshots";
import {
  ACCESS_TYPES,
  CONFIDENCE_LEVELS,
  PROVIDER_IDS,
  ProviderUsageSnapshotSchema,
  SOURCE_TYPES,
} from "@/lib/usage/snapshot-shape";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/usage/snapshots
 *   ?providerId=minimax&limit=20
 *
 * Read path. Returns snapshots, latest first. Uses `tryDb` under the
 * hood so a missing DB returns `{ snapshots: [], generatedAt: "…" }`
 * with 200 OK — the UI can render an empty state instead of crashing.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const providerIdRaw = url.searchParams.get("providerId");
  const limitRaw = url.searchParams.get("limit");

  let providerId: string | undefined;
  if (providerIdRaw && providerIdRaw.trim() !== "") {
    if (!PROVIDER_IDS.includes(providerIdRaw as (typeof PROVIDER_IDS)[number])) {
      return NextResponse.json(
        { error: "invalid_query", message: `Unknown providerId: ${providerIdRaw}` },
        { status: 400 },
      );
    }
    providerId = providerIdRaw;
  }

  let limit: number | undefined;
  if (limitRaw && limitRaw.trim() !== "") {
    const parsed = Number(limitRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return NextResponse.json(
        { error: "invalid_query", message: "limit must be a positive integer" },
        { status: 400 },
      );
    }
    limit = Math.min(Math.round(parsed), 200);
  }

  const rows = await listSnapshots({ providerId, limit });
  return NextResponse.json(
    {
      snapshots: rows,
      generatedAt: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// The write schema accepts a snapshot minus the server-managed
// id/createdAt/updatedAt columns; `capturedAt` may be supplied by the
// client (ISO 8601) but defaults to now() in the repo layer.
const snapshotWriteShape = {
  providerId: z.enum(PROVIDER_IDS),
  providerLabel: z.string().min(1),
  accessType: z.enum(ACCESS_TYPES),
  sourceType: z.enum(SOURCE_TYPES),
  confidence: z.enum(CONFIDENCE_LEVELS),
  planName: z.string().nullable().optional(),

  shortWindowLabel: z.string().nullable().optional(),
  shortWindowUsedPercent: z.number().int().min(0).max(100).nullable().optional(),
  shortWindowRemainingPercent: z.number().int().min(0).max(100).nullable().optional(),
  shortWindowResetLabel: z.string().nullable().optional(),

  weeklyWindowLabel: z.string().nullable().optional(),
  weeklyWindowUsedPercent: z.number().int().min(0).max(100).nullable().optional(),
  weeklyWindowRemainingPercent: z.number().int().min(0).max(100).nullable().optional(),
  weeklyWindowResetLabel: z.string().nullable().optional(),

  creditsRemaining: z.number().nullable().optional(),

  usageAtTimestampValue: z.string().nullable().optional(),
  usageAtTimestampLabel: z.string().nullable().optional(),
  last7DaysUsage: z.string().nullable().optional(),
  last30DaysUsage: z.string().nullable().optional(),

  estimatedInputTokens: z.number().int().nullable().optional(),
  estimatedOutputTokens: z.number().int().nullable().optional(),
  estimatedTotalTokens: z.number().int().nullable().optional(),
  configuredLimitTokens: z.number().int().nullable().optional(),
  estimatedRemainingTokens: z.number().int().nullable().optional(),

  capturedAt: z.string().optional(),
  notes: z.string().nullable().optional(),
  screenshotAttachmentId: z.string().nullable().optional(),
} as const;

const snapshotWriteSchema = z.object({
  snapshot: z.object(snapshotWriteShape),
});

/**
 * POST /api/usage/snapshots
 *
 * Insert a confirmed snapshot. The request body MUST include the
 * canonical snapshot shape (minus server-managed ids + timestamps).
 * The user has already confirmed the values in the UI; this endpoint
 * just persists them.
 *
 * Returns the persisted row (with id, capturedAt, createdAt, updatedAt).
 */
export async function POST(req: Request) {
  if (!isDbConfigured()) {
    return NextResponse.json(
      { error: "db_not_configured" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const parsed = snapshotWriteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_body",
        errors: parsed.error.issues.map((iss) => ({
          path: iss.path.join(".") || "<root>",
          message: iss.message,
        })),
      },
      { status: 400 },
    );
  }

  const write = parsed.data.snapshot as SnapshotWriteInput;

  // Defense-in-depth: enforce enum membership at the route boundary so
  // a future schema drift in `snapshot-shape.ts` cannot accidentally
  // let a value slip into the DB that the CHECK constraint would reject.
  if (
    !PROVIDER_IDS.includes(write.providerId as (typeof PROVIDER_IDS)[number]) ||
    !ACCESS_TYPES.includes(write.accessType as (typeof ACCESS_TYPES)[number]) ||
    !SOURCE_TYPES.includes(write.sourceType as (typeof SOURCE_TYPES)[number]) ||
    !CONFIDENCE_LEVELS.includes(write.confidence as (typeof CONFIDENCE_LEVELS)[number])
  ) {
    return NextResponse.json(
      { error: "invalid_body", message: "Enum field has unsupported value." },
      { status: 400 },
    );
  }

  try {
    const saved = await insertSnapshot(write);
    return NextResponse.json(
      { snapshot: saved },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: "db_error",
        message: err instanceof Error ? err.message : "Failed to persist snapshot.",
      },
      { status: 500 },
    );
  }
}

/**
 * Helper used by `/api/usage/quotas` to overlay the latest snapshot
 * per provider onto the local-log estimate. Not exported as an HTTP
 * method; the quotas route imports this module's helper instead of
 * going through HTTP to avoid a self-call loop.
 */
export async function overlayLatestSnapshotsByProvider(
  providerIds: ReadonlyArray<string>,
): Promise<Record<string, Awaited<ReturnType<typeof latestSnapshotByProvider>>>> {
  const out: Record<string, Awaited<ReturnType<typeof latestSnapshotByProvider>>> = {};
  for (const id of providerIds) {
    out[id] = await latestSnapshotByProvider(id);
  }
  return out;
}
