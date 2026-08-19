import "server-only";

import {
  MINIMAX_DISCOVERY_MAX_AGE_MS,
  getMiniMaxDiscoverySnapshot,
  writeMiniMaxDiscoveryFailure,
  writeMiniMaxDiscoverySuccess,
} from "@/lib/repo/minimax-models-discovery";
import { getMiniMaxConfig } from "./minimax";
import { fetchMiniMaxModels } from "./minimax-models-api";

export type MiniMaxRefreshOutcome =
  | { kind: "fresh"; source: "minimax"; modelIds: ReadonlyArray<string>; httpStatus: number }
  | {
      kind: "cache_fresh";
      ageMs: number;
      snapshot: Awaited<ReturnType<typeof getMiniMaxDiscoverySnapshot>>;
    }
  | {
      kind: "failed";
      reason: string;
      httpStatus: number | null;
      usedCache: boolean;
      snapshot: Awaited<ReturnType<typeof getMiniMaxDiscoverySnapshot>>;
    };

export async function refreshMiniMaxModels(
  opts: { force?: boolean } = {},
): Promise<MiniMaxRefreshOutcome> {
  const force = opts.force === true;
  const existing = await getMiniMaxDiscoverySnapshot();
  if (!force && existing.fetchedAt) {
    const ageMs = Date.now() - existing.fetchedAt.getTime();
    if (ageMs < MINIMAX_DISCOVERY_MAX_AGE_MS && existing.modelIds.length > 0) {
      return { kind: "cache_fresh", ageMs, snapshot: existing };
    }
  }

  const config = getMiniMaxConfig();
  if (!config.apiKey) {
    const reason = "MINIMAX_API_KEY is not configured.";
    await writeMiniMaxDiscoveryFailure({ errorMessage: reason, httpStatus: null }).catch(
      () => undefined,
    );
    return {
      kind: "failed",
      reason,
      httpStatus: null,
      usedCache: existing.modelIds.length > 0,
      snapshot: existing,
    };
  }

  const result = await fetchMiniMaxModels({ apiKey: config.apiKey, baseURL: config.baseURL });
  if (!result.ok) {
    await writeMiniMaxDiscoveryFailure({
      errorMessage: result.reason,
      httpStatus: result.httpStatus,
    }).catch(() => undefined);
    return {
      kind: "failed",
      reason: result.reason,
      httpStatus: result.httpStatus,
      usedCache: existing.modelIds.length > 0,
      snapshot: existing,
    };
  }

  try {
    await writeMiniMaxDiscoverySuccess({
      modelIds: result.modelIds,
      httpStatus: result.httpStatus,
    });
  } catch (err) {
    return {
      kind: "failed",
      reason: `fetched ${result.modelIds.length} MiniMax models but failed to persist: ${err instanceof Error ? err.message : String(err)}`,
      httpStatus: result.httpStatus,
      usedCache: existing.modelIds.length > 0,
      snapshot: existing,
    };
  }
  return {
    kind: "fresh",
    source: "minimax",
    modelIds: result.modelIds,
    httpStatus: result.httpStatus,
  };
}

export async function ensureMiniMaxDiscoveryFresh(): Promise<void> {
  const existing = await getMiniMaxDiscoverySnapshot();
  if (existing.fetchedAt) {
    const ageMs = Date.now() - existing.fetchedAt.getTime();
    if (ageMs < MINIMAX_DISCOVERY_MAX_AGE_MS && existing.modelIds.length > 0) return;
  }
  try {
    await refreshMiniMaxModels({ force: false });
  } catch (err) {
    console.error("[minimax-discovery] refresh failed:", err instanceof Error ? err.message : err);
  }
}
