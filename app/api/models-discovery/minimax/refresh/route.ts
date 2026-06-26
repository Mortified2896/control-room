import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import {
  refreshMiniMaxModels,
  type MiniMaxRefreshOutcome,
} from "@/lib/providers/minimax-discovery";

export const dynamic = "force-dynamic";

type Body = {
  outcome:
    | { kind: "fresh"; source: "minimax"; modelCount: number; httpStatus: number }
    | { kind: "cache_fresh"; ageMs: number; modelCount: number }
    | {
        kind: "failed";
        reason: string;
        httpStatus: number | null;
        usedCache: boolean;
        modelCount: number;
      };
};

function serialize(outcome: MiniMaxRefreshOutcome): Body {
  switch (outcome.kind) {
    case "fresh":
      return {
        outcome: {
          kind: "fresh",
          source: "minimax",
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
}

export async function POST() {
  if (!isDbConfigured()) {
    return NextResponse.json(
      { error: "db_not_configured" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const outcome = await refreshMiniMaxModels({ force: true });
  const status = outcome.kind === "failed" && !outcome.usedCache ? 502 : 200;
  return NextResponse.json(serialize(outcome), {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
