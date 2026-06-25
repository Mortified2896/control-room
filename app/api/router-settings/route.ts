import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import {
  getEffectiveRouterSettings,
  reloadEffectiveRouterSettings,
} from "@/lib/router/settings-store";
import {
  DEFAULT_ROUTER_SETTINGS,
  parseRouterSettingsForSave,
  type RouterSettings,
} from "@/lib/router/schema";
import { getEffectiveModelsRegistry, registryToRouterAllowlist } from "@/lib/providers/registry";
import { ensureDiscoveryFresh } from "@/lib/providers/openai-discovery";
import type { ReasoningLevel } from "@/lib/providers/types";
import { upsertRouterSettingsRow } from "@/lib/repo/router-settings";

export const dynamic = "force-dynamic";

/**
 * Settings DTO exposed to the Settings UI.
 *
 * The UI is allowed to see:
 *   - the effective settings (DB singleton or env defaults),
 *   - the schema defaults (so "Reset to safe defaults" is always one click),
 *   - the registry of (model, reasoning-level) combos the user can pick
 *     from, plus their tier, known/available/stale status, and the
 *     effective registry counts. This is the source of truth for which
 *     checkboxes/toggles the form renders.
 *
 * The chat route uses the effective settings directly (not the DTO), so
 * the API contract for chat remains unchanged.
 */
type RouterSettingsDto = {
  effective: RouterSettings;
  defaults: RouterSettings;
  configured: boolean;
  registry: ReadonlyArray<{
    modelId: string;
    modelLabel: string;
    reasoningLevel: ReasoningLevel;
    tier: "cheap" | "expensive";
    configured: boolean;
    available: boolean;
    stale: boolean;
  }>;
  effectiveRegistry: {
    models: ReadonlyArray<{
      modelId: string;
      displayLabel: string;
      configured: boolean;
      available: boolean;
      stale: boolean;
      supportsReasoning: boolean;
      supportedReasoningLevels: ReadonlyArray<ReasoningLevel>;
      tier: "standard" | "expensive" | "unknown";
      usableForChat: boolean;
      manualSelectorVisible: boolean;
      manuallyOverridden: boolean;
      routerEligible: boolean;
      capabilities: {
        reasoning: boolean;
        vision: boolean;
        images: boolean;
        functionCalling: boolean;
        structuredOutput: boolean;
        streaming: boolean;
      };
      provenance: "local_meta" | "discovered_only" | "fake" | "stale";
    }>;
    defaults: { manualModelId: string | null; reasoningLevel: ReasoningLevel };
    counts: {
      discovered: number;
      discoveredConfigured: number;
      discoveredUnclassified: number;
      configuredAvailable: number;
      stale: number;
      manualSelectorVisible: number;
      routerEligible: number;
    };
    discovery: {
      modelIds: ReadonlyArray<string>;
      fetchedAt: string | null;
      httpStatus: number | null;
      source: "openai" | "fake" | "fallback";
      rawCount: number | null;
      errorMessage: string | null;
      ageMs: number | null;
      isStale: boolean;
    };
    selectorPrefs: Record<string, { visible: boolean }>;
    fakeMode: boolean;
  };
};

function serializeDiscovery(
  discovery: Awaited<ReturnType<typeof getEffectiveModelsRegistry>>["discovery"],
) {
  const ageMs = discovery.fetchedAt ? Date.now() - discovery.fetchedAt.getTime() : null;
  return {
    modelIds: discovery.modelIds,
    fetchedAt: discovery.fetchedAt ? discovery.fetchedAt.toISOString() : null,
    httpStatus: discovery.httpStatus,
    source: discovery.source,
    rawCount: discovery.rawCount,
    errorMessage: discovery.errorMessage,
    ageMs,
    isStale: ageMs === null ? true : ageMs >= 24 * 60 * 60 * 1000,
  };
}

/**
 * GET /api/router-settings
 *
 * Returns:
 *   200 { effective, defaults, configured, registry, effectiveRegistry }
 *   503 { error: "db_not_configured" }   — DB required for the Settings UI
 *
 * We require the DB to be configured here even though `getRouterSettings`
 * works offline. Reason: the Settings UI is fundamentally about mutating
 * the persisted singleton, and showing it a UI that silently no-ops on
 * Save would be worse than a clear 503.
 *
 * Discovery freshness: opportunistically triggers a background refresh
 * when the cached snapshot is older than 24h or missing. The response is
 * served immediately from whatever the cache currently has — the refresh
 * is fire-and-forget and does not block the GET.
 */
export async function GET() {
  if (!isDbConfigured()) {
    return NextResponse.json(
      { error: "db_not_configured" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  // Synchronously trigger a refresh when the cache is empty / stale so
  // the Settings UI loads with a complete registry on first visit. This
  // is the ONLY path that calls discovery inline — the chat route
  // (`/api/chat`, `/api/models`) never does. The brief explicitly
  // forbids discovery on every chat request; this restriction does NOT
  // apply to the Settings UI GET, which is the user-facing entry point
  // for discovery itself.
  await ensureDiscoveryFresh();
  const [effective, registry] = await Promise.all([
    getEffectiveRouterSettings(),
    getEffectiveModelsRegistry(),
  ]);
  const dto: RouterSettingsDto = {
    effective,
    defaults: DEFAULT_ROUTER_SETTINGS,
    configured: true,
    registry: registryToRouterAllowlist(registry),
    effectiveRegistry: {
      models: registry.models,
      defaults: registry.defaults,
      counts: registry.counts,
      discovery: serializeDiscovery(registry.discovery),
      selectorPrefs: Object.fromEntries(
        Object.entries(registry.selectorPrefs).map(([k, v]) => [k, { visible: v.visible }]),
      ),
      fakeMode: registry.fakeMode,
    },
  };
  return NextResponse.json(dto, { headers: { "Cache-Control": "no-store" } });
}

/**
 * PUT /api/router-settings
 *
 * Body: a partial `RouterSettings` payload (any subset of the editable
 * fields). The DB singleton is fully replaced on success — we round-trip
 * the merged payload through the strict validator (with the live
 * registry, when available).
 *
 * Recognized keys (anything else is ignored for forward-compat):
 *   abEnabled, allowExpensiveModels, allowLongPromptWhenExpensive,
 *   longPromptThresholdChars, fallbackModelId, fallbackReasoningLevel,
 *   allowedCombos
 *
 * Responses:
 *   200 { settings }                        — saved
 *   400 { error: "invalid_body", errors }   — validation failure
 *   503 { error: "db_not_configured" }      — DB required
 */
export async function PUT(req: Request) {
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
    return NextResponse.json(
      { error: "invalid_body", reason: "request body must be JSON" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (body == null || typeof body !== "object") {
    return NextResponse.json(
      { error: "invalid_body", reason: "body must be a JSON object" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Read the effective settings so we can merge unknown/missing fields
  // from the partial payload (the UI only ships the fields it lets the
  // user touch; everything else must persist unchanged).
  const current = await getEffectiveRouterSettings();
  const b = body as Record<string, unknown>;
  // Reject obviously-wrong ids up-front so the strict validator doesn't
  // have to surface them later.
  for (const k of Object.keys(b)) {
    if (typeof k !== "string" || k.trim().length === 0 || k === "__proto__") {
      return NextResponse.json(
        { error: "invalid_body", reason: "payload contains an invalid key" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
  }
  // Reject path traversal / shape mistakes in `allowedCombos` so the
  // strict validator can return actionable per-field errors.
  if (
    b.allowedCombos !== undefined &&
    b.allowedCombos !== null &&
    !Array.isArray(b.allowedCombos)
  ) {
    return NextResponse.json(
      { error: "invalid_body", reason: "allowedCombos must be an array" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const merged: Record<string, unknown> = {
    abEnabled: b.abEnabled ?? current.abEnabled,
    allowExpensiveModels: b.allowExpensiveModels ?? current.allowExpensiveModels,
    allowLongPromptWhenExpensive:
      b.allowLongPromptWhenExpensive ?? current.allowLongPromptWhenExpensive,
    longPromptThresholdChars:
      b.longPromptThresholdChars === undefined
        ? current.longPromptThresholdChars
        : b.longPromptThresholdChars,
    fallbackModelId: b.fallbackModelId ?? current.fallbackModelId,
    fallbackReasoningLevel: b.fallbackReasoningLevel ?? current.fallbackReasoningLevel,
    allowedCombos: b.allowedCombos ?? current.allowedCombos,
    // Non-UI-managed fields round-trip from the existing effective
    // payload so a Save does not silently reset them to defaults.
    routerModelId: current.routerModelId,
    maxCostPerRecommendationUsd: current.maxCostPerRecommendationUsd,
    maxCostPerAbRunUsd: current.maxCostPerAbRunUsd,
  };

  // Read the live registry so the validator can reject unknown /
  // unavailable / stale combos at the save boundary (the brief: "must
  // never silently enter the router pool"). When the registry read
  // fails, fall back to the legacy static validator so a transient DB
  // failure does not lock out the user from saving.
  let registryForValidation: Awaited<ReturnType<typeof getEffectiveModelsRegistry>> | null = null;
  try {
    registryForValidation = await getEffectiveModelsRegistry();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[api/router-settings PUT] registry read failed, using legacy validator:",
      err instanceof Error ? err.message : err,
    );
    registryForValidation = null;
  }

  const validation = parseRouterSettingsForSave(merged, registryForValidation ?? undefined);
  if (!validation.ok) {
    return NextResponse.json(
      { error: "invalid_body", errors: validation.errors },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const writeResult = await upsertRouterSettingsRow({
      settings: validation.value,
      updatedBy: "settings-ui",
      registry: registryForValidation ?? undefined,
    });
    if (!writeResult.ok) {
      return NextResponse.json(
        { error: "invalid_body", errors: writeResult.errors },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    // Bust the in-process cache so the very next chat request sees the
    // updated settings without waiting for the TTL.
    const fresh = await reloadEffectiveRouterSettings();
    return NextResponse.json({ settings: fresh }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[api/router-settings PUT] db error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "db_error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
