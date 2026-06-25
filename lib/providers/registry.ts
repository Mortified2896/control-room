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

import type { ModelOption, ModelTier as LegacyModelTier, ReasoningLevel } from "./types";
import { DEFAULT_REASONING_LEVEL } from "./openai";
import { FAKE_OPENAI_MODEL_IDS, isFakeOpenAIModelsEnabled } from "./openai-models-fake";
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

export type EffectiveModelTier = "standard" | "expensive" | "unknown";

export type EffectiveModelEntry = {
  providerId: "openai";
  modelId: string;
  displayLabel: string;
  /** Present in the local static alias map. */
  known: boolean;
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
  /** The reasoning levels the local metadata lists for this model. */
  supportedReasoningLevels: ReadonlyArray<ReasoningLevel>;
  /** Tier, derived from local metadata or "unknown" for discovered-only. */
  tier: EffectiveModelTier;
  /** Can this model be the target of a real chat call right now? */
  usableForChat: boolean;
  /**
   * Should this model appear in the manual chat selector right now?
   * Combines known + available + supportsReasoning + OPENAI_API_KEY + the
   * user's explicit show/hide preference (defaulting to true for known
   * models and false for unknown / stale ones).
   */
  manualSelectorVisible: boolean;
  /**
   * Is this model eligible to enter the router pool right now? Strict
   * subset of `usableForChat`: must be known, available, supports
   * reasoning. Unknown and stale models are NEVER router-eligible; the
   * save-time validator (`lib/router/registry.ts`) enforces this even if
   * the UI lets the user try.
   */
  routerEligible: boolean;
  /**
   * Provenance marker so the UI can render a "fake / known / unknown"
   * badge without re-deriving the rule. Stable across calls.
   */
  provenance: "local_meta" | "discovered_only" | "fake" | "stale";
};

export type EffectiveRegistry = {
  models: ReadonlyArray<EffectiveModelEntry>;
  defaults: {
    manualModelId: string | null;
    reasoningLevel: ReasoningLevel;
  };
  discovery: DiscoverySnapshot;
  selectorPrefs: SelectorPreferences;
  counts: {
    discovered: number;
    known: number;
    available: number;
    stale: number;
    manualSelectorVisible: number;
    routerEligible: number;
  };
  fakeMode: boolean;
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
    reasoningLevels: ReadonlyArray<ReasoningLevel>;
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
        reasoningLevels: ReadonlyArray<ReasoningLevel>;
      },
    ]
  >;
};

const DEFAULT_REASONING_LEVELS: ReadonlyArray<ReasoningLevel> = ["low"];

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

  let knownCount = 0;
  let availableCount = 0;
  let staleCount = 0;
  let manualVisibleCount = 0;
  let routerEligibleCount = 0;

  for (const modelId of orderedIds) {
    const alias = resolveAlias(modelId);
    const isKnownModel = alias != null;
    if (isKnownModel) knownCount++;
    const inCurrentDiscovery = availableIds.has(modelId);
    const inPreviousSnapshot = previousIds.has(modelId);
    const available = inCurrentDiscovery;
    if (available) availableCount++;
    // Stale: was in the previous successful discovery but is no longer in
    // the current one. Only known + previously-seen models are
    // "stale" — unknown discovered ids simply vanish on the next refresh.
    const stale = !available && inPreviousSnapshot && isKnownModel;
    if (stale) staleCount++;

    const tier: EffectiveModelTier = alias
      ? alias.tier === "expensive"
        ? "expensive"
        : "standard"
      : "unknown";
    const supportedReasoningLevels = alias?.reasoningLevels ?? DEFAULT_REASONING_LEVELS;
    const supportsReasoning = supportedReasoningLevels.length > 0;

    const usableForChat = isKnownModel && available && supportsReasoning && input.openaiKeySet;

    // Manual selector visibility default:
    //   - known + available  -> visible (unless user hid it)
    //   - known + stale      -> hidden (user must re-enable after re-discovery)
    //   - unknown + available -> hidden by default (brief: "Unknown discovered
    //     models are hidden from the manual chat selector by default")
    //   - unknown + stale    -> hidden
    const pref = input.selectorPrefs[modelId];
    let manualSelectorVisible: boolean;
    if (pref && typeof pref.visible === "boolean") {
      manualSelectorVisible = pref.visible && usableForChat;
    } else {
      manualSelectorVisible = isKnownModel && available && usableForChat;
    }
    if (manualSelectorVisible) manualVisibleCount++;

    // Router eligibility is the strict subset: known + available +
    // supportsReasoning. Stale and unknown models are NEVER router
    // eligible, regardless of selector visibility (the brief: "must
    // never silently enter the router pool").
    const routerEligible = isKnownModel && available && supportsReasoning;
    if (routerEligible) routerEligibleCount++;

    // Derive provenance in priority order so the UI can render a stable
    // badge ("fake" / "known" / "unknown" / "stale") without re-deriving
    // the rule. The `fake` value only appears when the fake discovery
    // flag is enabled AND the id is one of the deterministic fake ids —
    // production never sees fake ids because fakeMode is false and the
    // fake-only ids are not added to `idsToRender` (see the `if (fakeMode)`
    // block above).
    let provenance: EffectiveModelEntry["provenance"];
    if (stale) {
      provenance = "stale";
    } else if (fakeMode && FAKE_OPENAI_MODEL_IDS.includes(modelId)) {
      provenance = "fake";
    } else if (!isKnownModel) {
      provenance = "discovered_only";
    } else {
      provenance = "local_meta";
    }

    entries.push({
      providerId: "openai",
      modelId,
      displayLabel: alias?.label ?? modelId,
      known: isKnownModel,
      available,
      stale,
      supportsReasoning,
      supportedReasoningLevels,
      tier,
      usableForChat,
      manualSelectorVisible,
      routerEligible,
      provenance,
    });
  }

  // Pick a deterministic default model id: the first manualSelectorVisible
  // entry (cheap tier preferred). When nothing is visible, fall back to
  // the first known alias id (so the picker can still render a default).
  const defaultModelId =
    entries.find((e) => e.manualSelectorVisible && e.tier !== "expensive")?.modelId ??
    entries.find((e) => e.manualSelectorVisible)?.modelId ??
    entries.find((e) => e.known)?.modelId ??
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
      known: knownCount,
      available: availableCount,
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
  return buildEffectiveRegistry({
    discovery,
    selectorPrefs,
    openaiKeySet: Boolean(process.env.OPENAI_API_KEY?.trim()),
  });
}

/**
 * Async wrapper that returns the legacy `ModelsResponse` shape consumed
 * by `app/assistant.tsx` and the chat route's `resolveModel` path.
 *
 * Filters to `manualSelectorVisible === true` so the chat composer only
 * ever shows models the user has opted into, plus the fallback behavior
 * (when the DB is unconfigured / no discovery ever ran, the static
 * catalog is still rendered exactly like pre-discovery).
 */
export async function getEffectiveModelsResponse(): Promise<{
  models: ReadonlyArray<ModelOption>;
  defaultModelId: string | null;
  defaultReasoningLevel: ReasoningLevel;
}> {
  const registry = await getEffectiveModelsRegistry();
  const filtered = registry.models.filter((m) => m.manualSelectorVisible);
  const models: ModelOption[] = filtered.map((m) => {
    const option: ModelOption = {
      providerId: m.providerId,
      providerLabel: "OpenAI",
      modelId: m.modelId,
      modelLabel: m.displayLabel,
      enabled: m.usableForChat,
      reasoningLevels: m.supportedReasoningLevels,
      tier: legacyTier(m.tier),
    };
    if (!m.usableForChat) {
      // Provide a reason string for the model picker when the model is
      // listed but not currently usable (e.g. the OpenAI key is unset
      // but the user has explicitly shown it).
      return {
        ...option,
        enabled: false,
        reason: "OPENAI_API_KEY is not configured",
      };
    }
    return option;
  });
  return {
    models,
    defaultModelId: registry.defaults.manualModelId,
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
  reasoningLevel: ReasoningLevel;
  tier: LegacyModelTier;
  known: boolean;
  available: boolean;
  stale: boolean;
}> {
  const out: Array<{
    modelId: string;
    modelLabel: string;
    reasoningLevel: ReasoningLevel;
    tier: LegacyModelTier;
    known: boolean;
    available: boolean;
    stale: boolean;
  }> = [];
  for (const entry of registry.models) {
    if (!entry.routerEligible) continue; // unknown + stale excluded
    for (const lvl of entry.supportedReasoningLevels) {
      out.push({
        modelId: entry.modelId,
        modelLabel: entry.displayLabel,
        reasoningLevel: lvl,
        tier: legacyTier(entry.tier),
        known: entry.known,
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
