/**
 * Reasoning capability refresh path.
 *
 * The capability model carries `source: "static" | "provider_refresh" | "manual"`
 * and `refreshedAt: string` so the UI can surface when the option set
 * was last confirmed. Static metadata from `openai-static.ts`,
 * `codex-catalog.ts`, and `minimax.ts` ships with `source: "static"`.
 *
 * Today, the OpenAI `/v1/models` endpoint and the Codex CLI do not
 * expose per-model reasoning-option sets. We therefore ship a stub
 * refresh that returns the static metadata and stamps
 * `refreshedAt` to `now` so the infrastructure is in place when a
 * provider-driven refresh becomes available.
 *
 * When a real provider refresh is wired in:
 *
 *   1. Each provider-specific refresh function below can call its
 *      respective API (e.g. an OpenAI admin endpoint, a Codex CLI
 *      probe, a MiniMax `/v1/models` call) and parse the response
 *      into a `ReasoningCapability`.
 *   2. The static metadata becomes a fallback: if the refresh
 *      fails or the API does not yet expose reasoning options,
 *      the function returns the static metadata with
 *      `source: "static"` and `refreshedAt` unchanged.
 *   3. The registry merge layer (see `lib/providers/registry.ts`)
 *      prefers `source: "provider_refresh"` over `source: "static"`.
 *
 * Callers MUST NOT mutate the static metadata in place — the refresh
 * functions always return a fresh capability object.
 */

import type { ReasoningCapability } from "./capability";
import { effortLevelsCapability } from "./capability";
import { CHEAP_TIER_REASONING_EFFORT_VALUES, FULL_REASONING_EFFORT_VALUES } from "./capability";

/**
 * Result of a single refresh attempt. `ok` is false when the
 * provider API is unreachable, returns an unexpected shape, or does
 * not yet expose reasoning options — in which case callers should
 * fall back to the static metadata.
 */
export type ReasoningRefreshResult =
  | { ok: true; capability: ReasoningCapability }
  | { ok: false; reason: string };

/**
 * Refresh the reasoning capability for an OpenAI model id.
 *
 * Today this is a no-op that returns the static metadata marked as
 * a successful refresh. The signature and shape are stable so a
 * future implementation can swap in a real provider call.
 */
export async function refreshOpenAIReasoningCapability(
  modelId: string,
  staticFallback: ReasoningCapability,
): Promise<ReasoningRefreshResult> {
  // OpenAI does not currently expose per-model reasoning-effort
  // levels via `/v1/models`. Until the API provides them, we treat
  // the static metadata as the authoritative option set. We still
  // call this on every request so the registry merge layer can
  // stamp `refreshedAt`.
  return {
    ok: true,
    capability: withRefreshedAt(staticFallback),
  };
}

/**
 * Refresh the reasoning capability for a Codex catalog model id.
 *
 * Codex CLI does not expose per-model reasoning-effort levels via a
 * public discovery endpoint today. We treat the static catalog as
 * authoritative and stamp `refreshedAt`.
 */
export async function refreshCodexReasoningCapability(
  modelId: string,
  staticFallback: ReasoningCapability,
): Promise<ReasoningRefreshResult> {
  return {
    ok: true,
    capability: withRefreshedAt(staticFallback),
  };
}

/**
 * Refresh the reasoning capability for a MiniMax model id.
 *
 * MiniMax does not currently expose per-model reasoning/thinking
 * modes via a public discovery endpoint. We treat the static
 * metadata as authoritative and stamp `refreshedAt`.
 */
export async function refreshMiniMaxReasoningCapability(
  modelId: string,
  staticFallback: ReasoningCapability,
): Promise<ReasoningRefreshResult> {
  return {
    ok: true,
    capability: withRefreshedAt(staticFallback),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return a copy of `capability` with `refreshedAt` set to the current
 * ISO timestamp. Used by the stub refresh path so the registry merge
 * layer can record when the option set was last confirmed.
 */
function withRefreshedAt(capability: ReasoningCapability): ReasoningCapability {
  const refreshedAt = new Date().toISOString();
  if (capability.kind === "effort_levels") {
    return {
      ...capability,
      refreshedAt,
      source: capability.source ?? "provider_refresh",
    };
  }
  if (capability.kind === "thinking_budget") {
    return {
      ...capability,
      refreshedAt,
      source: capability.source ?? "provider_refresh",
    };
  }
  return capability;
}

/**
 * Build a fallback capability from the conservative full-option set.
 * Used when the caller has no static metadata and the refresh path
 * returned no data. We surface the full set literally so the UI
 * shows `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
 *
 * `control` here is the narrower effort-level control — `"supported"`
 * or `"model_dependent"`. `"unknown"` returns an empty options
 * list (the UI must NOT render fake options for unknown surfaces).
 * `"unsupported"` would never reach this helper (it implies a
 * `none` capability, not `effort_levels`).
 */
export function fallbackOpenAIReasoningCapability(
  _modelId: string,
  control: "supported" | "model_dependent" | "unknown" = "supported",
): ReasoningCapability {
  if (control === "unknown") {
    return effortLevelsCapability([], "unknown", { source: "static" });
  }
  return effortLevelsCapability([...FULL_REASONING_EFFORT_VALUES], control, {
    defaultOption: "low",
    source: "static",
  });
}

/**
 * Build a fallback capability from the conservative cheap-tier set.
 * Used when the caller has no static metadata and the refresh path
 * returned no data for a cheap-tier model.
 */
export function fallbackCheapTierReasoningCapability(
  _modelId: string,
  control: "supported" | "model_dependent" | "unknown" = "supported",
): ReasoningCapability {
  if (control === "unknown") {
    return effortLevelsCapability([], "unknown", { source: "static" });
  }
  return effortLevelsCapability([...CHEAP_TIER_REASONING_EFFORT_VALUES], control, {
    defaultOption: "low",
    source: "static",
  });
}
