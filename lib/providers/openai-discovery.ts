import "server-only";

import {
  DISCOVERY_MAX_AGE_MS,
  getDiscoverySnapshot,
  writeDiscoveryFailure,
  writeDiscoverySuccess,
} from "@/lib/repo/openai-models-discovery";
import { fetchOpenAIModels } from "./openai-models-api";
import { getFakeOpenAIModelIds, isFakeOpenAIModelsEnabled } from "./openai-models-fake";

/**
 * Orchestrator for OpenAI model discovery.
 *
 * Decides whether to call OpenAI's GET /v1/models or return the cached
 * snapshot, persists the result, and never crashes the chat path.
 *
 * Strict constraints from the brief:
 *   - Never call OpenAI discovery on every chat request. The chat route
 *     only ever calls `getDiscoverySnapshot()` (a pure DB read). This
 *     module is invoked by the Settings UI route (`/api/models-discovery/
 *     refresh`) and by the synchronous `ensureDiscoveryFresh()` helper
 *     used at the top of the Settings UI and `/api/models` GET handlers —
 *     never from `/api/chat`.
 *   - If discovery fails, the last successful cache is preserved (the
 *     repo's `writeDiscoveryFailure` keeps `model_ids` untouched and just
 *     records the error).
 *   - If no cache exists and discovery fails, the registry layer falls
 *     back to the static catalog (see `lib/providers/registry.ts`).
 *   - Production must not enable fake discovery by default — the env
 *     flag defaults to off (see `openai-models-fake.ts`).
 */

export type RefreshOutcome =
  | {
      kind: "fresh";
      source: "openai" | "fake";
      modelIds: ReadonlyArray<string>;
      httpStatus: number;
    }
  | {
      kind: "cache_fresh";
      ageMs: number;
      snapshot: Awaited<ReturnType<typeof getDiscoverySnapshot>>;
    }
  | {
      kind: "failed";
      reason: string;
      httpStatus: number | null;
      usedCache: boolean;
      snapshot: Awaited<ReturnType<typeof getDiscoverySnapshot>>;
    };

/**
 * Force a refresh: always call the upstream (real OpenAI or fake),
 * persist the result, and return the outcome. The caller (Settings UI
 * manual-refresh button) is the only path that calls this with
 * `{ force: true }`.
 */
export async function refreshOpenAIModels(opts: { force?: boolean } = {}): Promise<RefreshOutcome> {
  const force = opts.force === true;
  const existing = await getDiscoverySnapshot();
  if (!force && existing.fetchedAt) {
    const ageMs = Date.now() - existing.fetchedAt.getTime();
    if (ageMs < DISCOVERY_MAX_AGE_MS && existing.modelIds.length > 0) {
      return { kind: "cache_fresh", ageMs, snapshot: existing };
    }
  }

  const fake = isFakeOpenAIModelsEnabled();
  if (fake) {
    const ids = getFakeOpenAIModelIds();
    try {
      await writeDiscoverySuccess({
        modelIds: ids,
        httpStatus: 200,
        source: "fake",
      });
      return { kind: "fresh", source: "fake", modelIds: ids, httpStatus: 200 };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Best-effort failure record. Even if the failure record itself
      // fails, we still return a structured failure to the caller.
      await writeDiscoveryFailure({ errorMessage: reason, httpStatus: null, source: "fake" }).catch(
        () => undefined,
      );
      return {
        kind: "failed",
        reason: `failed to persist fake discovery: ${reason}`,
        httpStatus: null,
        usedCache: existing.modelIds.length > 0,
        snapshot: existing,
      };
    }
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  if (!apiKey) {
    const reason = "OPENAI_API_KEY is not configured";
    await writeDiscoveryFailure({ errorMessage: reason, httpStatus: null, source: "openai" }).catch(
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

  const result = await fetchOpenAIModels({ apiKey });
  if (!result.ok) {
    await writeDiscoveryFailure({
      errorMessage: result.reason,
      httpStatus: result.httpStatus,
      source: "openai",
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
    await writeDiscoverySuccess({
      modelIds: result.modelIds,
      httpStatus: result.httpStatus,
      source: "openai",
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // The fetch succeeded but the persist failed — still report success
    // so the UI shows the new ids immediately, but warn that the cache
    // row write failed.
    return {
      kind: "failed",
      reason: `fetched ${result.modelIds.length} models but failed to persist: ${reason}`,
      httpStatus: result.httpStatus,
      usedCache: existing.modelIds.length > 0,
      snapshot: existing,
    };
  }
  return {
    kind: "fresh",
    source: "openai",
    modelIds: result.modelIds,
    httpStatus: result.httpStatus,
  };
}

/**
 * Best-effort freshness pass. Called once at the top of the Settings UI
 * GET handler so opening the page in a fresh tab can opportunistically
 * refresh the cache when it's older than the TTL. Awaits the refresh
 * when called synchronously from a Server Component / route handler —
 * the caller blocks on this so the response includes the refreshed
 * registry on first load.
 *
 * Critically: this function is NOT called from /api/chat. The chat path
 * always reads the cached snapshot via `getDiscoverySnapshot()` and
 * tolerates staleness. `/api/models` may call this best-effort freshness
 * helper because that endpoint is the model registry surface and should
 * accurately expose API models after an empty or stale cache.
 */
export async function ensureDiscoveryFresh(): Promise<void> {
  const existing = await getDiscoverySnapshot();
  if (existing.fetchedAt) {
    const ageMs = Date.now() - existing.fetchedAt.getTime();
    if (ageMs < DISCOVERY_MAX_AGE_MS && existing.modelIds.length > 0) return;
  }
  // Await so the Settings UI GET returns a fully-populated registry
  // on first visit. The refresh itself is bounded by
  // `DEFAULT_DISCOVERY_TIMEOUT_MS` (10s) so a stuck network call cannot
  // hang the page indefinitely.
  try {
    await refreshOpenAIModels({ force: false });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[openai-discovery] background refresh failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
