import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { refreshOpenAIModels, type RefreshOutcome } from "@/lib/providers/openai-discovery";
import {
  refreshMiniMaxModels,
  type MiniMaxRefreshOutcome,
} from "@/lib/providers/minimax-discovery";

export const dynamic = "force-dynamic";

type ProviderRefreshSummary = {
  kind: "fresh" | "cache_fresh" | "failed";
  modelCount: number;
  httpStatus?: number | null;
  reason?: string;
  usedCache?: boolean;
};

type RefreshResponseBody = {
  outcome: {
    kind: "fresh" | "partial_failed" | "failed";
    modelCount: number;
    minimaxModelCount: number;
    providers: {
      openai: ProviderRefreshSummary;
      minimax: ProviderRefreshSummary;
    };
  };
};

function summarizeOpenAI(outcome: RefreshOutcome): ProviderRefreshSummary {
  if (outcome.kind === "fresh") {
    return { kind: "fresh", modelCount: outcome.modelIds.length, httpStatus: outcome.httpStatus };
  }
  if (outcome.kind === "cache_fresh") {
    return { kind: "cache_fresh", modelCount: outcome.snapshot.modelIds.length };
  }
  return {
    kind: "failed",
    modelCount: outcome.snapshot.modelIds.length,
    httpStatus: outcome.httpStatus,
    reason: outcome.reason,
    usedCache: outcome.usedCache,
  };
}

function summarizeMiniMax(outcome: MiniMaxRefreshOutcome): ProviderRefreshSummary {
  if (outcome.kind === "fresh") {
    return { kind: "fresh", modelCount: outcome.modelIds.length, httpStatus: outcome.httpStatus };
  }
  if (outcome.kind === "cache_fresh") {
    return { kind: "cache_fresh", modelCount: outcome.snapshot.modelIds.length };
  }
  return {
    kind: "failed",
    modelCount: outcome.snapshot.modelIds.length,
    httpStatus: outcome.httpStatus,
    reason: outcome.reason,
    usedCache: outcome.usedCache,
  };
}

function serialize(openai: RefreshOutcome, minimax: MiniMaxRefreshOutcome): RefreshResponseBody {
  const openaiSummary = summarizeOpenAI(openai);
  const minimaxSummary = summarizeMiniMax(minimax);
  const failures = [openaiSummary, minimaxSummary].filter((p) => p.kind === "failed");
  return {
    outcome: {
      kind: failures.length === 0 ? "fresh" : failures.length === 2 ? "failed" : "partial_failed",
      modelCount: openaiSummary.modelCount,
      minimaxModelCount: minimaxSummary.modelCount,
      providers: { openai: openaiSummary, minimax: minimaxSummary },
    },
  };
}

/**
 * POST /api/models-discovery/refresh
 *
 * Force a refresh of provider model metadata.
 *
 * Refreshes every provider that currently exposes model discovery.
 *
 * Today that is OpenAI API and MiniMax API. Future providers should join this
 * endpoint so the Settings UI keeps one provider-agnostic "Refresh all models"
 * action instead of adding one button per provider.
 *
 * On per-provider failure, the previous successful cache is preserved and the
 * response includes a sanitized provider summary. Secrets are never returned.
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
  const [openai, minimax] = await Promise.all([
    refreshOpenAIModels({ force: true }),
    refreshMiniMaxModels({ force: true }),
  ]);
  return NextResponse.json(serialize(openai, minimax), {
    headers: { "Cache-Control": "no-store" },
  });
}
