// This module is intentionally NOT marked `import "server-only"` so the
// pure `buildEffectiveRegistry` function can be unit-tested without a
// Postgres connection. The async wrappers (`getEffectiveModelsRegistry`,
// `getEffectiveModelsResponse`) touch the DB via `lib/repo/*` which IS
// `server-only`; those calls fail safely under test runners that mock or
// stub them out.
//
// We import only the types from the repo modules via the type-only
// mirror files (the runtime `lib/repo/openai-models-discovery.ts` and
// `lib/repo/model-selector-prefs.ts` are `server-only` and would crash
// a unit-test loader that has no `server-only` shim).

import type { DiscoverySnapshot } from "@/lib/repo/openai-models-discovery-types";

import type { SelectorPreferences } from "@/lib/repo/model-selector-prefs-types";

import type { ModelOption, ModelTier as LegacyModelTier } from "./types";
import type { SupportedExecutionTarget } from "./codex-catalog";
import type { ReasoningCapability } from "./capability";
import {
  getEffectiveReasoningLevels,
  hasReasoningControls,
  UNKNOWN_REASONING_CAPABILITY,
} from "./capability";
import {
  refreshCodexReasoningCapability,
  refreshMiniMaxReasoningCapability,
  refreshOpenAIReasoningCapability,
} from "./reasoning-refresh";
import { DEFAULT_REASONING_LEVEL } from "./openai";
import { MINIMAX_M3_CAPABILITY, getDiscoveredMiniMaxModels } from "./minimax";
import { CODEX_CATALOG_MODELS } from "./codex-catalog";
import { FAKE_OPENAI_MODEL_IDS, isFakeOpenAIModelsEnabled } from "./openai-models-fake";
import { getProviderAccessSettings } from "./access-control";
// Defer the server-only repo imports to the async wrappers so unit tests
// that only exercise `buildEffectiveRegistry` can load this module
// without a Postgres pool and without a `server-only` runtime shim.
async function getDiscoverySnapshotAsync() {
  const mod = await import("@/lib/repo/openai-models-discovery");
  return mod.getDiscoverySnapshot();
}
async function getSelectorPreferencesAsync() {
  const mod = await import("@/lib/repo/model-selector-prefs");
  return mod.getSelectorPreferences();
}

import {
  getStaticOpenAIModelAlias,
  isKnownStaticOpenAIModel,
  listStaticOpenAIModelAliases,
} from "./openai-static";

/**
 * Effective model registry — the central merge layer between
 *
 *   1. OpenAI's discovered model list (`DiscoverySnapshot`),
 *   2. the local static metadata map (`lib/providers/openai-static.ts`),
 *   3. the manual selector visibility preferences
 *      (`model_selector_prefs.preferences`),
 *   4. the runtime provider-enabled check (OPENAI_API_KEY).
 *
 * The merge produces a single `EffectiveRegistry` DTO that:
 *   - the chat route consults (via `getEffectiveModelsResponse`) so the
 *     model picker only shows manual-selector-visible, currently-available
 *     models, never unknown / stale entries,
 *   - the Settings UI consults (via `getEffectiveModelsRegistry`) so it
 *     can render every discovered model + its known/unknown/available/stale
 *     status, while still gating the manual-selector toggle and the
 *     router-pool checkboxes against the same merge rules.
 *
 * Pure / deterministic given the same inputs. The async wrapper
 * `getEffectiveModelsRegistry()` reads the DB snapshots via `tryDb` and
 * never throws — the chat path must always have something to render.
 *
 * All entry ordering is deterministic (static-alias map order, then
 * discovered-only models alphabetical) so Playwright assertions against
 * model ids do not flake on iteration order.
 */

export type EffectiveModelTier = "standard" | "expensive" | "unknown" | "cheap";

export type EffectiveModelEntry = {
  providerId: "openai" | "codex" | "minimax";
  modelId: string;
  displayLabel: string;
  /**
   * "Configured" — present in the local static alias map. The model
   * has known display label, tier, and supported reasoning levels.
   * Renamed from `known` for UI clarity: the Settings page now renders
   * "OpenAI / Control Room" as two separate columns, and "Configured"
   * is the Control Room side.
   */
  configured: boolean;
  /** Present in the most recent successful OpenAI discovery snapshot. */
  available: boolean;
  /**
   * Present in the most recent successful discovery snapshot but NOT in
   * the current snapshot — derived state, never destructive. Stale
   * entries are still rendered in the Settings UI so the user can
   * decide what to do; the manual-selector toggle and the router pool
   * treat them as unavailable.
   */
  stale: boolean;
  /** Local metadata advertises at least one reasoning level. */
  supportsReasoning: boolean;
  /**
   * Execution targets this model id is eligible for. Populated by the
   * provider catalogs (Codex / MiniMax) and surfaced through this
   * registry so the harness layer never needs to consult a hard-coded
   * allowlist. OpenAI API models always list `["chat_model"]`.
   *
   * Optional on the type so test fixtures and legacy callers that
   * build an `EffectiveModelEntry` by hand can omit it; the harness
   * registry falls back to `["chat_model"]` when missing.
   */
  supportedExecutionTargets?: ReadonlyArray<SupportedExecutionTarget>;
  /**
   * Mirrors `supportsReasoning` but phrased for the harness approval
   * card. The card reads this to decide whether to render a reasoning
   * picker or just "provider default".
   */
  supportsReasoningLevels?: boolean;
  /**
   * Canonical reasoning / thinking capability for this model.
   * Surfaced as-is from the provider static metadata (OpenAI alias map,
   * Codex catalog, MiniMax M3 capability), possibly upgraded by
   * `lib/providers/reasoning-refresh.ts`, or as `kind: "unknown"` for
   * discovered-only / unconfigured entries. The UI must consult this
   * field to decide which control surface to render — never the
   * derived `supportedReasoningLevels` alone.
   */
  reasoningCapability: ReasoningCapability;
  /**
   * Derived legacy field — concrete list of provider-native option
   * values, derived from `reasoningCapability` via
   * `getEffectiveReasoningLevels`. Empty for thinking-budget, none,
   * and unknown capabilities. Values are provider-native strings,
   * NOT the narrow `ReasoningLevel` enum — Codex `xhigh` or MiniMax
   * `adaptive` flow through unchanged.
   */
  supportedReasoningLevels: ReadonlyArray<string>;
  /** Tier, derived from local metadata or "unknown" for discovered-only. */
  tier: EffectiveModelTier;
  /**
   * Can this model be the target of a real chat call right now? Strict
   * semantic: configured + available + supports reasoning + OPENAI_API_KEY
   * set. Unconfigured models are never `usableForChat` because Control
   * Room has no local metadata to drive their chat-side behavior.
   */
  usableForChat: boolean;
  /**
   * Should this model appear in the manual chat selector right now?
   *
   * Combines configured + available + supportsReasoning + OPENAI_API_KEY
   * + the user's explicit show/hide preference.
   *
   * Default visibility:
   *   - configured + available → visible (unless user hid it)
   *   - configured + stale    → hidden (user must re-enable after re-discovery)
   *   - unconfigured + available → hidden by default
   *   - unconfigured + stale → hidden
   *
   * Explicit opt-in: when `pref.visible === true` the model is shown
   * even if it would otherwise be hidden. This is how users can pick
   * up an unconfigured OpenAI model for experimentation. The brief:
   * "I should be allowed to enable it in the manual model selector
   * even if it has no local metadata."
   *
   * Even when `manualSelectorVisible === true`, the chat composer still
   * marks the model with `enabled: false` when OPENAI_API_KEY is unset.
   */
  manualSelectorVisible: boolean;
  /**
   * Did the user explicitly opt in? Distinguishes "visible by default"
   * from "visible because the user overrode the default". The Settings
   * UI shows an inline warning when toggling an unconfigured model on.
   */
  manuallyOverridden: boolean;
  /**
   * Is this model eligible to enter the router pool right now? Strict
   * subset: must be configured, available, supports reasoning, AND not
   * stale. Unconfigured and stale models are NEVER router-eligible; the
   * save-time validator (`lib/router/registry.ts`) enforces this even if
   * the UI lets the user try. The brief is explicit:
   * "Unknown/unclassified models must still NOT be router eligible.
   * Only locally configured models with explicit metadata may appear in
   * the router recommendation pool."
   */
  routerEligible: boolean;
  /**
   * Capability placeholders — future surface for the capability
   * registry. Currently only `reasoning` is sourced from local
   * metadata; the rest are always `false` for every model. They are
   * rendered in the UI as disabled checkboxes so the capability UI is
   * in place before the capability registry ships.
   */
  capabilities: {
    reasoning: boolean;
    vision: boolean;
    images: boolean;
    functionCalling: boolean;
    structuredOutput: boolean;
    streaming: boolean;
  };
  /**
   * Provenance marker so the UI can render a "fake / known / unknown"
   * badge without re-deriving the rule. Stable across calls.
   */
  provenance: "local_meta" | "discovered_only" | "fake" | "stale" | "env_static";
};

export type EffectiveRegistry = {
  models: ReadonlyArray<EffectiveModelEntry>;
  defaults: {
    manualModelId: string | null;
    /** Provider-native default reasoning-effort value. */
    reasoningLevel: string;
  };
  discovery: DiscoverySnapshot;
  selectorPrefs: SelectorPreferences;
  counts: {
    /** Total ids in the most recent OpenAI discovery snapshot. */
    discovered: number;
    /** Discovered ids that also have local metadata. */
    discoveredConfigured: number;
    /** Discovered ids with no local metadata (the brief's "unclassified"). */
    discoveredUnclassified: number;
    /** Configured models currently available from OpenAI. */
    configuredAvailable: number;
    /** Configured models that disappeared from the latest discovery (stale). */
    stale: number;
    /** Models in the user's manual selector right now. */
    manualSelectorVisible: number;
    /** Models the router may pick from (configured + available + supports reasoning). */
    routerEligible: number;
  };
  fakeMode: boolean;
  /**
   * Map from model id to the refreshed reasoning capability. Set
   * only by the async `getEffectiveModelsRegistry` path; the sync
   * `buildEffectiveRegistry` returns an empty map. Covers OpenAI,
   * Codex (`codex:<id>`), and MiniMax (`MiniMax-M3`) ids so the
   * chat-picker DTO can apply the refreshed metadata to rows that
   * are not part of the sync registry (Codex / MiniMax are appended
   * separately in `getEffectiveModelsResponse`).
   */
  refreshedCapabilitiesById?: ReadonlyMap<string, ReasoningCapability>;
};

function legacyTier(tier: EffectiveModelTier): LegacyModelTier {
  if (tier === "expensive") return "expensive";
  return "cheap";
}

export type BuildRegistryInput = {
  discovery: DiscoverySnapshot;
  selectorPrefs: SelectorPreferences;
  openaiKeySet: boolean;
  fakeMode?: boolean;
  /** Optional override for the set of "currently available" model ids.
   * Defaults to `discovery.modelIds`. Useful for tests that want to
   * simulate "model disappeared" without rewriting the snapshot row. */
  availableOverride?: ReadonlyArray<string>;
  /**
   * Optional override for the static alias map (keyed by model id, value
   * is the static alias tuple). Defaults to the production map. Used by
   * unit tests to exercise the merge without `process.env` reads.
   */
  staticAliasResolver?: (modelId: string) => {
    label: string;
    tier: "cheap" | "expensive";
    reasoningCapability: ReasoningCapability;
  } | null;
  /** Optional override for "is this id a known static model?". */
  isKnownOverride?: (modelId: string) => boolean;
  /** Optional override for the deterministic "all known aliases" iterator. */
  listKnownAliasesOverride?: () => ReadonlyArray<
    readonly [
      string,
      {
        label: string;
        tier: "cheap" | "expensive";
        reasoningCapability: ReasoningCapability;
      },
    ]
  >;
};

/**
 * Capability for a model id the registry has no static metadata for.
 *
 * Historically this was `["low"]`, which lied about capability and
 * forced the runtime to ship a fake `reasoningEffort: "low"` parameter.
 * The honest answer for an unknown OpenAI model is `kind: "unknown",
 * control: "unknown"` — the UI shows "Reasoning capability unknown"
 * and the runtime omits any reasoning params.
 */
const UNKNOWN_DISCOVERED_CAPABILITY: ReasoningCapability = UNKNOWN_REASONING_CAPABILITY;

function defaultStaticAliasResolver(modelId: string) {
  return getStaticOpenAIModelAlias(modelId);
}

function defaultListKnownAliases() {
  return listStaticOpenAIModelAliases();
}

function defaultIsKnown(modelId: string) {
  return isKnownStaticOpenAIModel(modelId);
}

export function buildEffectiveRegistry(input: BuildRegistryInput): EffectiveRegistry {
  const resolveAlias = input.staticAliasResolver ?? defaultStaticAliasResolver;
  const isKnown = input.isKnownOverride ?? defaultIsKnown;
  const listKnown = input.listKnownAliasesOverride ?? defaultListKnownAliases;

  const fakeMode = input.fakeMode ?? isFakeOpenAIModelsEnabled();
  const availableIds = new Set(input.availableOverride ?? input.discovery.modelIds);
  const previousIds = new Set(input.discovery.previousModelIds);

  // Union of "models we have any reason to talk about":
  //   - every model in the static alias map (known),
  //   - every model id in the current discovery (discovered),
  //   - every model id in the *previous* discovery (so a model that
  //     disappeared between refreshes still renders as Stale),
  //   - every model id in the selector prefs the user has explicitly
  //     toggled (so we can still render their state even if OpenAI
  //     dropped the model),
  //   - in fake mode, the deterministic fake ids (so they appear even
  //     when the DB row is fresh-but-empty).
  const idsToRender = new Set<string>();
  for (const [id] of listKnown()) idsToRender.add(id);
  for (const id of availableIds) idsToRender.add(id);
  for (const id of previousIds) idsToRender.add(id);
  for (const id of Object.keys(input.selectorPrefs)) idsToRender.add(id);
  if (fakeMode) {
    for (const id of FAKE_OPENAI_MODEL_IDS) idsToRender.add(id);
  }

  const entries: EffectiveModelEntry[] = [];
  // Render in a deterministic order: known first (in alias-map order),
  // then discovered-only alphabetical.
  const knownIds: string[] = [];
  const discoveredOnlyIds: string[] = [];
  for (const id of idsToRender) {
    if (isKnown(id)) knownIds.push(id);
    else discoveredOnlyIds.push(id);
  }
  // knownIds follows alias-map order from listKnown(); sort again to be
  // defensive if a test override returns out-of-order entries.
  const knownIdOrder = new Map<string, number>();
  let idx = 0;
  for (const [id] of listKnown()) {
    knownIdOrder.set(id, idx++);
  }
  knownIds.sort((a, b) => (knownIdOrder.get(a) ?? 0) - (knownIdOrder.get(b) ?? 0));
  discoveredOnlyIds.sort();
  const orderedIds = [...knownIds, ...discoveredOnlyIds];

  let configuredAvailableCount = 0;
  let discoveredConfiguredCount = 0;
  let discoveredUnclassifiedCount = 0;
  let staleCount = 0;
  let manualVisibleCount = 0;
  let routerEligibleCount = 0;

  for (const modelId of orderedIds) {
    const alias = resolveAlias(modelId);
    const isConfiguredModel = alias != null;
    const inCurrentDiscovery = availableIds.has(modelId);
    const inPreviousSnapshot = previousIds.has(modelId);
    const available = inCurrentDiscovery;
    // Stale: was in the previous successful discovery but is no longer in
    // the current one. Only configured + previously-seen models are
    // "stale" — unconfigured discovered ids simply vanish on the next
    // refresh.
    const stale = !available && inPreviousSnapshot && isConfiguredModel;
    if (stale) staleCount++;

    if (available) {
      if (isConfiguredModel) discoveredConfiguredCount++;
      else discoveredUnclassifiedCount++;
    }

    const tier: EffectiveModelTier = alias
      ? alias.tier === "expensive"
        ? "expensive"
        : "standard"
      : "unknown";
    // Stamp `source: "static"` on the sync build path too so
    // callers that only exercise `buildEffectiveRegistry` (unit
    // tests, future direct callers) still see a `source` value.
    // The async refresh path can later upgrade this to
    // `"provider_refresh"`.
    const reasoningCapability: ReasoningCapability = alias?.reasoningCapability
      ? (alias.reasoningCapability.kind === "effort_levels" ||
          alias.reasoningCapability.kind === "thinking_budget") &&
        !alias.reasoningCapability.source
        ? { ...alias.reasoningCapability, source: "static" as const }
        : alias.reasoningCapability
      : UNKNOWN_DISCOVERED_CAPABILITY;
    const supportedReasoningLevels = getEffectiveReasoningLevels(reasoningCapability);
    // `supportsReasoning` is true when the capability advertises any
    // reasoning surface at all (supported / model_dependent). It is
    // false for `kind: "none"` and `kind: "unknown"`. Note: this is
    // NOT just `supportedReasoningLevels.length > 0` — a thinking-
    // budget model has zero effort levels but does support reasoning,
    // so the registry still considers it router-eligible when its
    // underlying capability says so.
    const supportsReasoning = hasReasoningControls(reasoningCapability);

    // `usableForChat` is the strict "can Control Room actually drive
    // a chat call" signal. Unconfigured models are never `usableForChat`
    // because we have no local metadata for them; the chat route will
    // refuse them. The brief asks for less-restrictive SELECTOR
    // behavior, not less-restrictive chat behavior.
    const usableForChat = isConfiguredModel && available && supportsReasoning && input.openaiKeySet;
    if (usableForChat) configuredAvailableCount++;

    // Manual selector visibility:
    //   - Default: configured + available + supports reasoning +
    //     OPENAI_API_KEY → visible. Everything else → hidden.
    //   - Override: when the user has an explicit `pref.visible=true`
    //     on this model id, the model is shown regardless of
    //     classification. This is the "I want to experiment with this
    //     unconfigured OpenAI model" path the brief asks for. The
    //     composer will still gate `enabled` on OPENAI_API_KEY; the
    //     chat route will refuse the model at runtime if it's not
    //     configured.
    //   - Hidden override: explicit `pref.visible=false` wins over any
    //     default.
    const pref = input.selectorPrefs[modelId];
    let manualSelectorVisible: boolean;
    let manuallyOverridden = false;
    if (pref && typeof pref.visible === "boolean") {
      // The user explicitly set a preference — that overrides the
      // default. We still keep `manualSelectorVisible` independent of
      // `usableForChat` for opted-in models so the user can SEE the row
      // even when OPENAI_API_KEY is unset; the composer shows it
      // disabled with a clear reason.
      manualSelectorVisible = pref.visible;
      manuallyOverridden = true;
    } else {
      manualSelectorVisible = isConfiguredModel && available && usableForChat;
    }
    if (manualSelectorVisible) manualVisibleCount++;

    // Router eligibility is the strict subset: configured + available +
    // supports reasoning + not stale. Unconfigured and stale models are
    // NEVER router eligible, regardless of selector visibility (the
    // brief: "must never silently enter the router pool"). The
    // explicit-opt-in path cannot override this.
    const routerEligible = isConfiguredModel && available && supportsReasoning && !stale;
    if (routerEligible) routerEligibleCount++;

    // Derive provenance in priority order so the UI can render a stable
    // badge ("fake" / "configured" / "unclassified" / "stale") without
    // re-deriving the rule. The `fake` value only appears when the fake
    // discovery flag is enabled AND the id is one of the deterministic
    // fake ids — production never sees fake ids because fakeMode is
    // false and the fake-only ids are not added to `idsToRender`.
    let provenance: EffectiveModelEntry["provenance"];
    if (stale) {
      provenance = "stale";
    } else if (fakeMode && FAKE_OPENAI_MODEL_IDS.includes(modelId)) {
      provenance = "fake";
    } else if (!isConfiguredModel) {
      provenance = "discovered_only";
    } else {
      provenance = "local_meta";
    }

    entries.push({
      providerId: "openai",
      modelId,
      displayLabel: alias?.label ?? modelId,
      configured: isConfiguredModel,
      available,
      stale,
      supportsReasoning,
      // OpenAI API models are chat-only — never the target of a
      // Codex CLI / MiniMax CLI execution harness. The harness
      // approval card filters by this field so Codex / MiniMax can
      // never accidentally recommend `gpt-5.4-mini`.
      supportedExecutionTargets: ["chat_model"] as const,
      // OpenAI API models always advertise the reasoning-effort
      // picker — the model catalog lists at least one effort level.
      supportsReasoningLevels: supportsReasoning,
      reasoningCapability,
      supportedReasoningLevels,
      tier,
      usableForChat,
      manualSelectorVisible,
      manuallyOverridden,
      routerEligible,
      // Capability placeholders — only `reasoning` is sourced today
      // from local metadata; the rest are always false until the
      // capability registry ships. UI surfaces these as disabled
      // checkboxes so the layout is stable.
      capabilities: {
        reasoning: supportsReasoning,
        vision: false,
        images: false,
        functionCalling: false,
        structuredOutput: false,
        streaming: true,
      },
      provenance,
    });
  }

  // Pick a deterministic default model id: prefer configured + available
  // (cheap tier) so the picker never opens onto an unconfigured model.
  // Fall back to any opted-in visible entry, then any configured alias.
  const defaultModelId =
    entries.find((e) => e.manualSelectorVisible && e.configured && e.tier !== "expensive")
      ?.modelId ??
    entries.find((e) => e.manualSelectorVisible && e.configured)?.modelId ??
    entries.find((e) => e.manualSelectorVisible)?.modelId ??
    entries.find((e) => e.configured)?.modelId ??
    null;

  return {
    models: entries,
    defaults: {
      manualModelId: defaultModelId,
      reasoningLevel: DEFAULT_REASONING_LEVEL,
    },
    discovery: input.discovery,
    selectorPrefs: input.selectorPrefs,
    counts: {
      discovered: input.discovery.modelIds.length,
      discoveredConfigured: discoveredConfiguredCount,
      discoveredUnclassified: discoveredUnclassifiedCount,
      configuredAvailable: configuredAvailableCount,
      stale: staleCount,
      manualSelectorVisible: manualVisibleCount,
      routerEligible: routerEligibleCount,
    },
    fakeMode,
  };
}

/**
 * Async wrapper. Reads the discovery snapshot and selector prefs via
 * `tryDb` (so a missing DB never breaks the chat path) and produces the
 * effective registry.
 */
export async function getEffectiveModelsRegistry(): Promise<EffectiveRegistry> {
  const [discovery, selectorPrefs] = await Promise.all([
    getDiscoverySnapshotAsync(),
    getSelectorPreferencesAsync(),
  ]);
  const base = buildEffectiveRegistry({
    discovery,
    selectorPrefs,
    openaiKeySet: Boolean(process.env.OPENAI_API_KEY?.trim()),
  });
  // Refresh reasoning capability metadata. The refresh path lives in
  // `lib/providers/reasoning-refresh.ts` and stamps `refreshedAt` /
  // upgrades `source` to `"provider_refresh"` when a real provider
  // discovery is wired in. Today the refresh is a no-op that returns
  // the static metadata, but the registry merge still records the
  // timestamp so the UI can show "Refreshed Xm ago".
  const { refreshed, byId } = await refreshAllCapabilities(base);
  // Stash the refreshed Codex + MiniMax capabilities on the base
  // registry object so `getEffectiveModelsResponse` can apply them
  // when it builds the chat-picker payload. The base sync registry
  // does not include Codex/MiniMax entries, so the refresh loop
  // can't reach them — this field is the bridge.
  return {
    ...refreshed,
    refreshedCapabilitiesById: byId,
  };
}

/**
 * Run the per-provider refresh path for every model in `registry`
 * and return a new registry whose `reasoningCapability` carries the
 * latest `source` / `refreshedAt` values. Failures fall back to the
 * static metadata so a transient refresh error never strips
 * reasoning options from a model that genuinely supports them.
 */
async function refreshAllCapabilities(
  registry: EffectiveRegistry,
): Promise<{ refreshed: EffectiveRegistry; byId: ReadonlyMap<string, ReasoningCapability> }> {
  // Build the list of (modelId, static fallback) pairs we want to
  // refresh. Codex catalog + MiniMax-M3 + every OpenAI static alias
  // map to a refresh call. Discovered-only / unconfigured models
  // keep their `kind: "unknown"` capability and do not need a
  // refresh.
  const refreshTargets: Array<{
    modelId: string;
    fallback: ReasoningCapability;
    refresh: () => Promise<
      { ok: true; capability: ReasoningCapability } | { ok: false; reason: string }
    >;
  }> = [];
  for (const model of registry.models) {
    if (!model.configured) continue;
    if (model.providerId !== "openai") continue;
    refreshTargets.push({
      modelId: model.modelId,
      fallback: model.reasoningCapability,
      refresh: () => refreshOpenAIReasoningCapability(model.modelId, model.reasoningCapability),
    });
  }
  for (const codex of CODEX_CATALOG_MODELS) {
    refreshTargets.push({
      modelId: `codex:${codex.id}`,
      fallback: codex.reasoningCapability,
      refresh: () => refreshCodexReasoningCapability(codex.id, codex.reasoningCapability),
    });
  }
  refreshTargets.push({
    modelId: "MiniMax-M3",
    fallback: MINIMAX_M3_CAPABILITY,
    refresh: () => refreshMiniMaxReasoningCapability("MiniMax-M3", MINIMAX_M3_CAPABILITY),
  });

  const results = await Promise.all(
    refreshTargets.map(async (t) => {
      try {
        const result = await t.refresh();
        // The refresh path always returns the capability (even on
        // The refresh path returns the refreshed capability on
        // `ok: true` and a `reason` on `ok: false`. The static
        // fallback is what we surface when refresh fails (so the
        // registry merge layer can stamp `refreshedAt` and keep the
        // chat picker functional).
        const capability = result.ok ? result.capability : t.fallback;
        return { modelId: t.modelId, capability };
      } catch {
        return { modelId: t.modelId, capability: t.fallback };
      }
    }),
  );
  const byId = new Map(results.map((r) => [r.modelId, r.capability] as const));
  const refreshedModels = registry.models.map((m) => {
    const next = byId.get(m.modelId);
    if (!next || next === m.reasoningCapability) return m;
    return {
      ...m,
      reasoningCapability: next,
      supportedReasoningLevels: getEffectiveReasoningLevels(next),
    };
  });
  return { refreshed: { ...registry, models: refreshedModels }, byId };
}

/**
 * Async wrapper that returns the legacy `ModelsResponse` shape consumed
 * by `app/assistant.tsx` and the chat route's `resolveModel` path.
 *
 * Filters to `manualSelectorVisible === true` so the chat composer only
 * ever shows models the user has opted into. The `enabled` flag in the
 * response is set independently:
 *
 *   enabled = manualSelectorVisible && provider access allows manual
 *             OpenAI API use && openaiKeySet && supportsReasoning
 *
 * — so an opted-in unconfigured model, or an available API model while
 * OpenAI manual access is disabled in Settings, is VISIBLE in the
 * registry but DISABLED for the chat picker with a clear reason. This
 * keeps `/api/models` accurate as a provider registry without pretending
 * the manual chat picker may call models blocked by access settings.
 *
 * Configured + available models with the key set and manual access enabled get `enabled: true`.
 * Everything visible without the key gets `enabled: false` with a
 * reason string.
 */
export async function getEffectiveModelsResponse(): Promise<{
  models: ReadonlyArray<ModelOption>;
  defaultModelId: string | null;
  defaultReasoningLevel: string;
}> {
  const [registry, access, selectorPrefs] = await Promise.all([
    getEffectiveModelsRegistry(),
    getProviderAccessSettings(),
    import("@/lib/repo/model-selector-prefs").then((m) => m.getSelectorPreferences()),
  ]);
  const openaiAccess = access.find((p) => p.provider_id === "openai_api");
  const minimaxAccess = access.find((p) => p.provider_id === "minimax_api");
  const codexAccess = access.find((p) => p.provider_id === "codex_subscription");

  /**
   * Honor the user-curated `selectorPrefs` for every chat-picker
   * entry. OpenAI rows use it via `manualSelectorVisible` on the
   * registry, but Codex + MiniMax rows are appended here directly,
   * so we have to apply the same filter here. Missing pref = default
   * visible (the persisted pref is opt-in user customization, never
   * a hide-by-default).
   */
  const isPrefVisible = (modelId: string): boolean => {
    const pref = selectorPrefs[modelId];
    return pref ? pref.visible : true;
  };

  const filtered = registry.models.filter((m) => m.manualSelectorVisible);
  const models: ModelOption[] = filtered.map((m) => {
    const canCallNow =
      openaiAccess?.enabled &&
      openaiAccess.allow_manual &&
      m.configured &&
      m.available &&
      m.supportsReasoning &&
      process.env.OPENAI_API_KEY?.trim();
    const option: ModelOption = {
      providerId: m.providerId,
      providerLabel: "OpenAI API billing",
      modelId: m.modelId,
      modelLabel: `OpenAI API · ${m.displayLabel}`,
      enabled: Boolean(canCallNow),
      accessPath: "openai_api",
      billingLabel: "OpenAI API billing",
      capabilityKind: "model_provider",
      description:
        "Access: OpenAI API key · OpenAI API billing. Direct OpenAI API call; not subscription-backed. This provider is API-billed per token and is never a silent fallback under the no-API-billing-fallback policy.",
      // Pass-through the registry's execution targets — the harness
      // registry reads this field directly so a future cross-surface
      // OpenAI model (e.g. a Codex CLI row that ALSO accepts OpenAI
      // API calls) doesn't need an extra registry edit.
      supportedExecutionTargets: m.supportedExecutionTargets ?? (["chat_model"] as const),
      supportsReasoningLevels: m.supportsReasoningLevels ?? m.supportedReasoningLevels.length > 0,
      reasoningCapability: m.reasoningCapability,
      reasoningLevels: m.supportedReasoningLevels,
      tier: legacyTier(m.tier),
    };
    if (!canCallNow) {
      // Provide a precise reason string for the model picker when the
      // model is listed but not currently selectable. Unconfigured
      // models opted-in via the Settings UI get a different reason
      // than models that are simply missing the API key.
      const reason = !m.configured
        ? "Not configured in Control Room — chat calls will be refused."
        : !process.env.OPENAI_API_KEY?.trim()
          ? "OPENAI_API_KEY is not configured."
          : !openaiAccess?.enabled
            ? "OpenAI API provider is disabled in Settings."
            : !openaiAccess.allow_manual
              ? "OpenAI API manual chat is disabled in Settings."
              : "Not currently available from OpenAI.";
      return {
        ...option,
        enabled: false,
        reason,
      };
    }
    return option;
  });
  const codexEnabled = Boolean(codexAccess?.enabled && codexAccess.allow_manual);
  const codexModels: ModelOption[] = CODEX_CATALOG_MODELS.filter((m) =>
    isPrefVisible(`codex:${m.id}`),
  ).map((m) => {
    // Apply the refreshed capability when the async refresh path
    // produced one. The sync catalog entry carries
    // `source: "static"` + no `refreshedAt`; the async path
    // upgrades both fields. The `byId` lookup is by the prefixed
    // id (`codex:<id>`) since that is the id the chat composer
    // uses to address the row.
    const refreshed = registry.refreshedCapabilitiesById?.get(`codex:${m.id}`);
    const capability = refreshed ?? m.reasoningCapability;
    return {
      providerId: "codex",
      providerLabel: "Codex subscription",
      modelId: `codex:${m.id}`,
      modelLabel: `Codex · ${m.label} · Codex subscription`,
      enabled: codexEnabled,
      accessPath: "codex_chatgpt",
      billingLabel: "Codex subscription",
      capabilityKind: "agent_backend",
      description: `Access: Codex CLI / ChatGPT login. Source: Official Codex catalog.${
        m.mayBePlanGated ? " May require Pro." : ""
      } This is a subscription-backed chat provider; it is never an API-billed fallback under the no-API-billing-fallback policy.`,
      // Codex catalog rows are the target of `codex_cli` execution.
      // They never enter the MiniMax CLI harness registry path;
      // surfacing `minimax_cli` here would falsely advertise Codex
      // models as MiniMax-compatible.
      supportedExecutionTargets: m.supportedExecutionTargets,
      supportsReasoningLevels: m.supportsReasoningLevels,
      // Honest per-model capability — the Codex CLI / config / IDE
      // surfaces `reasoning_effort` when the underlying model
      // supports it. We mirror the documented set for known models
      // and use `model_dependent` for the research-preview
      // `gpt-5.3-codex-spark`. The legacy `reasoningLevels` is
      // derived from this so the registry UI renders the real
      // per-model checkboxes.
      reasoningCapability: capability,
      reasoningLevels: getEffectiveReasoningLevels(capability),
      tier: m.tier,
      ...(codexEnabled
        ? {}
        : { reason: "Codex subscription manual chat is disabled in Settings." }),
    };
  });
  const minimaxModels = (await getDiscoveredMiniMaxModels())
    .filter((m) => isPrefVisible(m.modelId))
    .map((m) => {
      // Apply the refreshed capability when the async refresh
      // path produced one for this MiniMax model id. The M3
      // entry's refresh target is `MiniMax-M3`; discovered-only
      // MiniMax ids (M2, M2.1, …) have no refresh target today
      // and keep their static `thinking_budget + unknown`
      // capability.
      const refreshed = registry.refreshedCapabilitiesById?.get(m.modelId);
      const baseCapability = m.reasoningCapability;
      const capability = refreshed ?? baseCapability;
      return {
        ...m,
        modelLabel: `${m.modelLabel} · token plan`,
        // Pass through the catalog-declared execution targets
        // (`["chat_model", "minimax_cli"]` for the default M3 id;
        // `["chat_model", "minimax_cli"]` for discovered ids — the
        // harness registry rejects anything not in its
        // `allowedModelIds`).
        supportedExecutionTargets:
          m.supportedExecutionTargets ?? (["chat_model", "minimax_cli"] as const),
        supportsReasoningLevels: m.supportsReasoningLevels ?? true,
        reasoningCapability: capability,
        reasoningLevels: getEffectiveReasoningLevels(capability),
        enabled: Boolean(m.enabled && minimaxAccess?.enabled && minimaxAccess.allow_manual),
        reason: !minimaxAccess?.enabled
          ? "MiniMax API key provider is disabled in Settings."
          : !minimaxAccess.allow_manual
            ? "MiniMax manual chat is disabled in Settings."
            : m.reason,
      };
    });
  const allModels = [...models, ...minimaxModels, ...codexModels];
  const defaultModelId =
    registry.defaults.manualModelId &&
    allModels.some((m) => m.modelId === registry.defaults.manualModelId && m.enabled)
      ? registry.defaults.manualModelId
      : (allModels.find((m) => m.enabled)?.modelId ?? null);
  return {
    models: allModels,
    defaultModelId,
    defaultReasoningLevel: registry.defaults.reasoningLevel,
  };
}

/**
 * Convert an `EffectiveRegistry` into a legacy `RouterAllowlistEntry`
 * list for the existing router pool table UI. Mirrors the behavior of
 * `listRouterAllowedPool(true)` but uses the live registry (so unknown
 * and stale entries are excluded) and preserves the `reasoningLevel`
 * ordering.
 */
export function registryToRouterAllowlist(registry: EffectiveRegistry): ReadonlyArray<{
  modelId: string;
  modelLabel: string;
  reasoningLevel: string;
  tier: LegacyModelTier;
  configured: boolean;
  available: boolean;
  stale: boolean;
}> {
  const out: Array<{
    modelId: string;
    modelLabel: string;
    /** Provider-native reasoning-effort value (e.g. "low", "xhigh"). */
    reasoningLevel: string;
    tier: LegacyModelTier;
    configured: boolean;
    available: boolean;
    stale: boolean;
  }> = [];
  for (const entry of registry.models) {
    if (!entry.routerEligible) continue; // unconfigured + stale excluded
    for (const lvl of entry.supportedReasoningLevels) {
      out.push({
        modelId: entry.modelId,
        modelLabel: entry.displayLabel,
        reasoningLevel: lvl,
        tier: legacyTier(entry.tier),
        configured: entry.configured,
        available: entry.available,
        stale: entry.stale,
      });
    }
  }
  // Stable order: cheap first, then alphabetical by modelId, then by level.
  out.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier.localeCompare(b.tier);
    if (a.modelId !== b.modelId) return a.modelId.localeCompare(b.modelId);
    return a.reasoningLevel.localeCompare(b.reasoningLevel);
  });
  return out;
}
