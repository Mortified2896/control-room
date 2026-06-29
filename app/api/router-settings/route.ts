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
import { buildNormalChatRecommenderPrompt } from "@/lib/router/normal-chat-prompts";
import { getEffectiveModelsResponse } from "@/lib/providers/registry";
import {
  buildEffectiveRegistry,
  getEffectiveModelsRegistry,
  registryToRouterAllowlist,
} from "@/lib/providers/registry";
import { EMPTY_DISCOVERY_SNAPSHOT } from "@/lib/repo/openai-models-discovery-types";
import { EMPTY_SELECTOR_PREFERENCES } from "@/lib/repo/model-selector-prefs-types";
import { ensureDiscoveryFresh } from "@/lib/providers/openai-discovery";
import { ensureMiniMaxDiscoveryFresh } from "@/lib/providers/minimax-discovery";
import {
  getDiscoveredMiniMaxModels,
  getMiniMaxConfig,
  minimaxProvider,
} from "@/lib/providers/minimax";
import { getMiniMaxDiscoverySnapshot } from "@/lib/repo/minimax-models-discovery";
import type { ProviderId } from "@/lib/providers/types";
import type { ReasoningCapability } from "@/lib/providers/capability";
import { getEffectiveReasoningLevels, hasReasoningControls } from "@/lib/providers/capability";
import { CODEX_CATALOG_MODELS } from "@/lib/providers/codex-catalog";
import { getProviderAccessSettings } from "@/lib/providers/access-control";
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
    /** Provider-native reasoning-effort value. */
    reasoningLevel: string;
    tier: "cheap" | "expensive";
    configured: boolean;
    available: boolean;
    stale: boolean;
  }>;
  effectiveRegistry: {
    models: ReadonlyArray<{
      providerId: ProviderId | "codex";
      providerLabel: string;
      modelId: string;
      displayLabel: string;
      configured: boolean;
      available: boolean;
      stale: boolean;
      /**
       * Canonical reasoning / thinking capability for the row. See
       * `lib/providers/capability.ts` for the full union. The Settings
       * UI consults this to decide which control surface to render in
       * the Reasoning column — never the legacy
       * `supportedReasoningLevels` alone, because a thinking-budget
       * model has zero effort levels but does support reasoning.
       */
      reasoningCapability: ReasoningCapability;
      supportsReasoning: boolean;
      supportedReasoningLevels: ReadonlyArray<string>;
      tier: "standard" | "expensive" | "unknown" | "cheap";
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
      provenance: "local_meta" | "discovered_only" | "fake" | "stale" | "env_static";
    }>;
    defaults: { manualModelId: string | null; reasoningLevel: string };
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
    minimaxDiscovery: {
      modelIds: ReadonlyArray<string>;
      fetchedAt: string | null;
      httpStatus: number | null;
      source: "minimax" | "fallback";
      rawCount: number | null;
      errorMessage: string | null;
      ageMs: number | null;
      isStale: boolean;
    };
    selectorPrefs: Record<string, { visible: boolean }>;
    fakeMode: boolean;
  };
  /**
   * Read-only preview of the prompt the normal-chat recommender sends
   * to the configured recommender model. Built with the live registry
   * so the Settings UI shows exactly what the API route sends — no
   * drift between the two surfaces. The user message, current model,
   * and availableModels are filled with representative example values
   * because the live prompt is dynamic and per-message.
   */
  normalChatRecommenderPrompt: {
    system: string;
    user: string;
    /** Pretty-printed JSON of the user prompt body for the read-only preview. */
    userJsonExample: string;
  };
};

function getFallbackEffectiveRegistry(): ReturnType<typeof buildEffectiveRegistry> {
  return buildEffectiveRegistry({
    discovery: EMPTY_DISCOVERY_SNAPSHOT,
    selectorPrefs: EMPTY_SELECTOR_PREFERENCES,
    openaiKeySet: Boolean(process.env.OPENAI_API_KEY?.trim()),
  });
}

async function serializeRegistryModels(
  registry: Awaited<ReturnType<typeof getEffectiveModelsRegistry>>,
): Promise<RouterSettingsDto["effectiveRegistry"]["models"]> {
  // The async refresh path runs for Codex + MiniMax too; apply the
  // refreshed capabilities so the Settings DTO shows the same
  // `source` / `refreshedAt` values as the chat-picker endpoint.
  const refreshedById = registry.refreshedCapabilitiesById;
  function applyRefreshed<
    T extends {
      modelId?: string;
      id?: string;
      reasoningCapability: import("@/lib/providers/capability").ReasoningCapability;
    },
  >(m: T, modelId: string): T {
    const next = refreshedById?.get(modelId);
    if (!next || next === m.reasoningCapability) return m;
    return { ...m, reasoningCapability: next };
  }
  const openaiRows = registry.models.map((m) => ({
    ...m,
    providerId: "openai" as const,
    providerLabel: "OpenAI API",
  }));
  const minimaxConfig = getMiniMaxConfig();
  const minimaxSnapshot = await getMiniMaxDiscoverySnapshot();
  const minimaxRows = (await getDiscoveredMiniMaxModels()).map((m) => {
    const refreshedMinimax = applyRefreshed(m, m.modelId);
    return {
      providerId: minimaxProvider.id,
      providerLabel: "MiniMax API",
      modelId: m.modelId,
      displayLabel: m.modelLabel,
      configured: true,
      available: m.enabled,
      stale: minimaxSnapshot.fetchedAt
        ? Date.now() - minimaxSnapshot.fetchedAt.getTime() >= 24 * 60 * 60 * 1000
        : true,
      reasoningCapability: m.reasoningCapability,
      supportsReasoning: hasReasoningControls(m.reasoningCapability),
      supportedReasoningLevels: getEffectiveReasoningLevels(m.reasoningCapability),
      tier: "standard" as const,
      usableForChat: m.enabled,
      manualSelectorVisible: true,
      manuallyOverridden: false,
      routerEligible: false,
      capabilities: {
        reasoning: hasReasoningControls(refreshedMinimax.reasoningCapability),
        vision: false,
        images: false,
        functionCalling: false,
        structuredOutput: false,
        streaming: true,
      },
      provenance: "env_static" as const,
      // Keep the read above intentional: this row reflects env-file config only.
      ...(!minimaxConfig.apiKeySet ? { available: false, usableForChat: false } : {}),
    };
  });
  const codexRows = CODEX_CATALOG_MODELS.map((m) => {
    const refreshedCodex = applyRefreshed(m, `codex:${m.id}`);
    return {
      providerId: "codex" as const,
      providerLabel: "Codex CLI / ChatGPT login",
      modelId: `codex:${m.id}`,
      displayLabel: `Codex · ${m.label}`,
      configured: true,
      available: true,
      stale: false,
      reasoningCapability: refreshedCodex.reasoningCapability,
      supportsReasoning: hasReasoningControls(refreshedCodex.reasoningCapability),
      supportedReasoningLevels: getEffectiveReasoningLevels(refreshedCodex.reasoningCapability),
      tier: m.tier === "expensive" ? ("expensive" as const) : ("standard" as const),
      usableForChat: true,
      manualSelectorVisible: true,
      manuallyOverridden: false,
      routerEligible: false,
      capabilities: {
        reasoning: hasReasoningControls(refreshedCodex.reasoningCapability),
        vision: false,
        images: false,
        functionCalling: false,
        structuredOutput: false,
        streaming: true,
      },
      provenance: "env_static" as const,
    };
  });
  return [...openaiRows, ...codexRows, ...minimaxRows];
}

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
 * Build the read-only prompt preview shown in the Settings UI. Uses
 * the live registry for the availableModels list (so the preview
 * matches what the API route will send) and representative example
 * values for the dynamic per-message fields.
 *
 * The example is intentionally a small "plan a 2-day trip" prompt
 * because it exercises both branches the recommender cares about —
 * the message is non-trivial, so the preview shows the recommender
 * gets enough context to make a meaningful decision.
 */
/**
 * Async prompt preview that pulls the live `getEffectiveModelsResponse`
 * shape so the availableModels list matches exactly what
 * `/api/model/recommend` will see. Called by the GET handler.
 */
async function buildNormalChatRecommenderPromptPreview(): Promise<
  RouterSettingsDto["normalChatRecommenderPrompt"]
> {
  const modelsPayload = await getEffectiveModelsResponse();
  const availableModels = modelsPayload.models
    .filter((m) => m.enabled && m.providerId !== "codex")
    .slice(0, 6) // Cap so the preview stays scannable
    .map((m) => ({
      provider: m.providerId,
      modelId: m.modelId,
      displayLabel: m.modelLabel,
      supportsReasoningControls:
        m.reasoningCapability.kind === "effort_levels" &&
        m.reasoningCapability.control !== "unknown",
      allowedReasoningLevels:
        m.reasoningCapability.kind === "effort_levels"
          ? m.reasoningCapability.options.map((o) => o.value)
          : [],
      enabled: m.enabled,
      accessPath: m.accessPath ?? null,
      tier: m.tier as "cheap" | "expensive" | "standard" | "unknown",
    }));
  const defaultModel = modelsPayload.models.find((m) => m.modelId === modelsPayload.defaultModelId);
  const prompt = buildNormalChatRecommenderPrompt({
    mode: "normal_chat",
    message: "Plan a 2-day trip to Kyoto in October with budget-friendly museum stops.",
    current: {
      modelId: modelsPayload.defaultModelId,
      provider: defaultModel?.providerId ?? "openai",
      reasoningLevel: modelsPayload.defaultReasoningLevel,
    },
    availableModels,
  });
  return {
    system: prompt.system,
    user: prompt.user,
    userJsonExample: prompt.user,
  };
}

function serializeMiniMaxDiscovery(
  discovery: Awaited<ReturnType<typeof getMiniMaxDiscoverySnapshot>>,
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
  const configured = isDbConfigured();
  // Synchronously trigger a refresh only when the DB is configured. Without
  // Postgres, the settings page should still load in read-only/defaults mode
  // instead of failing the whole page with db_not_configured.
  if (configured) {
    try {
      await Promise.all([ensureDiscoveryFresh(), ensureMiniMaxDiscoveryFresh()]);
    } catch (err) {
      // The settings page must still load if OpenAI discovery or its backing
      // cache is temporarily unavailable. Surface the stale/fallback registry
      // below instead of failing the whole page.
      console.error(
        "[api/router-settings GET] discovery refresh failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  let effective: RouterSettings;
  try {
    effective = await getEffectiveRouterSettings();
  } catch (err) {
    console.error(
      "[api/router-settings GET] settings read failed, using defaults:",
      err instanceof Error ? err.message : err,
    );
    effective = DEFAULT_ROUTER_SETTINGS;
  }

  let registry: Awaited<ReturnType<typeof getEffectiveModelsRegistry>>;
  try {
    registry = await getEffectiveModelsRegistry();
  } catch (err) {
    console.error(
      "[api/router-settings GET] registry read failed, using fallback registry:",
      err instanceof Error ? err.message : err,
    );
    registry = getFallbackEffectiveRegistry();
  }
  const minimaxDiscovery = await getMiniMaxDiscoverySnapshot();
  const providerAccess = await getProviderAccessSettings();
  const openaiAccess = providerAccess.find((p) => p.provider_id === "openai_api");
  const minimaxAccess = providerAccess.find((p) => p.provider_id === "minimax_api");
  const codexAccess = providerAccess.find((p) => p.provider_id === "codex_subscription");

  const dto: RouterSettingsDto & { providerAccess: typeof providerAccess } = {
    effective,
    defaults: DEFAULT_ROUTER_SETTINGS,
    configured,
    registry: registryToRouterAllowlist(registry),
    effectiveRegistry: {
      models: (await serializeRegistryModels(registry)).map((m) => {
        const access =
          m.providerId === "openai"
            ? openaiAccess
            : m.providerId === "codex"
              ? codexAccess
              : minimaxAccess;
        if (!access?.enabled) {
          return {
            ...m,
            available: false,
            usableForChat: false,
            manualSelectorVisible: false,
            routerEligible: false,
          };
        }
        return {
          ...m,
          manualSelectorVisible: m.manualSelectorVisible && access.allow_manual,
          routerEligible: m.routerEligible && access.allow_router,
        };
      }),
      defaults: registry.defaults,
      counts: registry.counts,
      discovery: serializeDiscovery(registry.discovery),
      minimaxDiscovery: serializeMiniMaxDiscovery(minimaxDiscovery),
      selectorPrefs: Object.fromEntries(
        Object.entries(registry.selectorPrefs).map(([k, v]) => [k, { visible: v.visible }]),
      ),
      fakeMode: registry.fakeMode,
    },
    // Build the read-only prompt preview using the live registry so the
    // Settings UI shows the same prompt the API route will send. We use
    // a representative example for the message + current model since the
    // live prompt is dynamic per send.
    normalChatRecommenderPrompt: await buildNormalChatRecommenderPromptPreview(),
    providerAccess,
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
 *   longPromptThresholdChars, failureBehavior, fallbackModelId,
 *   fallbackReasoningLevel, allowedCombos
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
    failureBehavior: b.failureBehavior ?? current.failureBehavior,
    fallbackModelId: b.fallbackModelId ?? current.fallbackModelId,
    fallbackReasoningLevel: b.fallbackReasoningLevel ?? current.fallbackReasoningLevel,
    allowedCombos: b.allowedCombos ?? current.allowedCombos,
    routerModelId: b.routerModelId ?? current.routerModelId,
    normalChatRecommenderModelId:
      b.normalChatRecommenderModelId ?? current.normalChatRecommenderModelId,
    normalChatRecommenderReasoningLevel:
      b.normalChatRecommenderReasoningLevel ?? current.normalChatRecommenderReasoningLevel,
    // Recommender allowlist: `null` means "no restriction" and must
    // round-trip as `null`. `[]` means "block all". When the UI omits
    // the field, keep the existing value.
    normalChatRecommenderAllowedModels:
      b.normalChatRecommenderAllowedModels === undefined
        ? current.normalChatRecommenderAllowedModels
        : b.normalChatRecommenderAllowedModels,
    // Non-UI-managed fields round-trip from the existing effective
    // payload so a Save does not silently reset them to defaults.
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
