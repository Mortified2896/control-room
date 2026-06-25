import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { refreshOpenAIModels, type RefreshOutcome } from "@/lib/providers/openai-discovery";
import { getDiscoverySnapshot } from "@/lib/repo/openai-models-discovery";

export const dynamic = "force-dynamic";

type RefreshResponseBody = {
  outcome:
    | { kind: "fresh"; source: "openai" | "fake"; modelCount: number; httpStatus: number }
    | { kind: "cache_fresh"; ageMs: number; modelCount: number }
    | {
        kind: "failed";
        reason: string;
        httpStatus: number | null;
        usedCache: boolean;
        modelCount: number;
      };
};

function serialize(outcome: RefreshOutcome, snapshotModelCount: number): RefreshResponseBody {
  switch (outcome.kind) {
    case "fresh":
      return {
        outcome: {
          kind: "fresh",
          source: outcome.source,
          modelCount: outcome.modelIds.length,
          httpStatus: outcome.httpStatus,
        },
      };
    case "cache_fresh":
      return {
        outcome: {
          kind: "cache_fresh",
          ageMs: outcome.ageMs,
          modelCount: outcome.snapshot.modelIds.length,
        },
      };
    case "failed":
      return {
        outcome: {
          kind: "failed",
          reason: outcome.reason,
          httpStatus: outcome.httpStatus,
          usedCache: outcome.usedCache,
          modelCount: outcome.snapshot.modelIds.length,
        },
      };
  }
  // Unreachable but TS exhaustiveness requires a return.
  void snapshotModelCount;
  throw new Error("unreachable");
}

/**
 * POST /api/models-discovery/refresh
 *
 * Force a refresh of the OpenAI model discovery cache.
 *
 * Behavior:
 *   - With fake mode enabled (`CONTROL_ROOM_FAKE_OPENAI_MODELS=1` or
 *     `CONTROL_ROOM_FAKE_LLM=1`), the cache is rewritten with the
 *     deterministic fake model list. No network call is made.
 *   - In production with a configured `OPENAI_API_KEY`, the cache is
 *     rewritten with the live `/v1/models` response.
 *   - On failure: the previous successful cache is preserved (the
 *     failure is recorded in `error_message` for the Settings UI), and
 *     the response includes `usedCache: true` so the UI can show the
 *     stale-but-known ids.
 *
 * Responses:
 *   200 { outcome }
 *   503 { error: "db_not_configured" }   — DB required for persistence
 */
export async function POST() {
  if (!isDbConfigured()) {
    return NextResponse.json(
      { error: "db_not_configured" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const outcome = await refreshOpenAIModels({ force: true });
  const fallbackSnapshot = await getDiscoverySnapshot();
  return NextResponse.json(serialize(outcome, fallbackSnapshot.modelIds.length), {
    headers: { "Cache-Control": "no-store" },
  });
}
