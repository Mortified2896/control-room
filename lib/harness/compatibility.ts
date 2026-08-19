import "server-only";

/**
 * Central coding-harness compatibility resolver.
 *
 * This module is the SINGLE SOURCE OF TRUTH for which (harness, model,
 * reasoning-level) tuples are valid for a coding task. The router,
 * the recommender route, the chat composer's harness approval card,
 * and the dispatcher all consult this module — none of them
 * re-derives the compatibility rules independently.
 *
 * Hard rules (from AGENTS.md + the routing-cleanup brief):
 *
 *   - Codex CLI candidates come ONLY from the central Codex
 *     catalog (`CODEX_CATALOG_MODELS` in
 *     `lib/providers/codex-catalog.ts`). Each Codex catalog row
 *     carries `supportedExecutionTargets: ["codex_cli"]` by
 *     construction, so the candidate filter is identity.
 *
 *   - MiniMax CLI candidates come ONLY from the MiniMax provider
 *     (`getMiniMaxModels()` / discovered ids in
 *     `lib/providers/minimax.ts`), and are then intersected with
 *     the harness's `allowedModelIds`. Today this resolves to
 *     `["MiniMax-M3"]` because the registry's `allowedModelIds`
 *     for MiniMax is hard-coded to that one id. MiniMax M2 /
 *     M2.1 / etc. that discovery may surface are filtered out by
 *     `allowedModelIds` — never visible to the MiniMax CLI
 *     runner.
 *
 *   - Codex CLI MUST NEVER receive MiniMax models.
 *   - MiniMax CLI MUST NEVER receive Codex / OpenAI models.
 *
 *   - OpenCode / Pi are PLACEHOLDERS for now. They produce ZERO
 *     candidates unless the operator has explicitly added a
 *     registry entry with `allowedModelIds` for them. Until
 *     that entry exists, `getCodingHarnessCandidates()` never
 *     returns a row for them. This is the
 *     "do not route to OpenCode / Pi unless configured as
 *     available" rule from the brief.
 *
 *   - OpenAI API chat-only models (anything whose
 *     `supportedExecutionTargets` does NOT include `codex_cli`
 *     or `minimax_cli`) are NEVER valid coding-harness pairs.
 *     They do not appear in the candidate list regardless of
 *     what the registry's `allowedModelIds` happens to contain,
 *     because the catalog lookup is the upstream gate.
 *
 * The shape this module returns (`ValidCodingPair`) is also what
 * the route handler passes back to the chat composer — the pill
 * renderer + the "Use <other> instead" flow consume this shape
 * verbatim. The previous inline candidate-building in
 * `/api/coding-harness/recommend/route.ts` was deleted in favour
 * of this module; if compatibility rules change, this file is
 * the only place that needs editing.
 */

import {
  CODEX_CATALOG_MODELS,
  isCodexCatalogModelId,
} from "@/lib/providers/codex-catalog";
import {
  getMiniMaxModels,
  MINIMAX_DEFAULT_MODEL_ID,
} from "@/lib/providers/minimax";
import { getEffectiveReasoningLevels } from "@/lib/providers/capability";
import type { ReasoningCapability } from "@/lib/providers/capability";
import {
  HARNESS_REGISTRY,
  harnessSupportsModelById,
  probeHarnessStatuses,
  registryWithStatus,
  stripHarnessModelPrefix,
  type HarnessId,
  type HarnessRegistryEntry,
  type HarnessStatus,
  type HarnessStatusSnapshot,
} from "./registry";

/**
 * Canonical valid coding-harness execution pair. One entry per
 * `(harness, model)` combination; the harness's `defaultModelId` +
 * `allowedModelIds` defines the cartesian product. The
 * `selectedReasoningLevel` is coerced via
 * `resolveReasoningLevelForPair()` so the caller never has to
 * reason about the provider-native label set.
 *
 * The route returns this shape (with the inner fields renamed
 * to `recommendedHarness` / `recommendedModelId` /
 * `recommendedReasoningLevel`) to the chat composer, which feeds
 * it to the harness approval card and the
 * "Use <other harness> instead" switch.
 */
export type ValidCodingPair = {
  /** Harness id, e.g. `"codex_cli"` / `"minimax_cli"`. */
  harnessId: HarnessId;
  /** Human-readable label, e.g. `"Codex CLI"` / `"MiniMax CLI"`. */
  harnessDisplayName: string;
  /**
   * Catalog model id WITHOUT the `codex:` / `minimax:` prefix.
   * The dispatcher expects bare ids.
   */
  modelId: string;
  /** Human-readable model label from the catalog. */
  modelDisplayName: string;
  /**
   * Resolved reasoning / thinking level. For Codex CLI this is
   * one of the model's `supportedReasoningLevels` (default
   * `"low"` for the cheap tier). For MiniMax CLI it is always
   * the literal string `"provider_default"` because the CLI
   * surface does not accept a reasoning-effort knob today.
   */
  selectedReasoningLevel: string;
  /**
   * All reasoning / thinking levels the chosen model id
   * advertises. The chat composer uses this to render either a
   * picker (Codex) or a "provider default" notice (MiniMax).
   */
  supportedReasoningLevels: ReadonlyArray<string>;
  /** e.g. `"Codex CLI / ChatGPT login"`. */
  providerPath: string;
  /** e.g. `"ChatGPT subscription"`. */
  billingPath: string;
  /** Live status from the harness probe. */
  harnessStatus: HarnessStatus;
  /** Short user-facing reason when `harnessStatus === "unavailable"`. */
  unavailableReason: string | null;
  requiresProjectFolder: boolean;
  canModifyFiles: boolean;
};

/**
 * Snapshot of the Codex catalog row used by the resolver. Re-exports
 * the canonical shape so callers do not need to depend on the
 * catalog module directly.
 */
type CodexCatalogEntry = (typeof CODEX_CATALOG_MODELS)[number];

/**
 * MiniMax catalog row shape, sourced from `getMiniMaxModels()`. We
 * do not import the model-option shape directly because the
 * compatibility module only consumes a small subset of fields.
 */
type MiniMaxCatalogEntry = {
  modelId: string;
  modelLabel: string;
  reasoningCapability: ReasoningCapability;
  supportedExecutionTargets?: ReadonlyArray<string>;
};

/**
 * Internal registry iteration helper. Yields every entry in the
 * live registry view (post-probe) so the candidate builder can
 * consult status + reasons without re-probing.
 */
async function liveRegistry(): Promise<ReadonlyArray<HarnessRegistryEntry>> {
  let snapshots: ReadonlyArray<HarnessStatusSnapshot> = [];
  try {
    snapshots = await probeHarnessStatuses();
  } catch {
    snapshots = [];
  }
  return registryWithStatus(snapshots);
}

/**
 * Read the reasoning / thinking capability for a Codex catalog id.
 * Falls back to a conservative `low`-only capability when the row
 * is missing (defensive: the catalog should be exhaustive).
 */
function codexCapability(modelId: string): ReasoningCapability | null {
  if (!isCodexCatalogModelId(modelId)) return null;
  return CODEX_CATALOG_MODELS.find((m) => m.id === modelId)?.reasoningCapability ?? null;
}

/**
 * Read the reasoning / thinking capability for a MiniMax model id.
 * Falls back to `null` when the row is missing.
 */
function minimaxCapability(modelId: string): ReasoningCapability | null {
  const row = getMiniMaxModels().find((m) => m.modelId === modelId);
  return row?.reasoningCapability ?? null;
}

/**
 * Catalog lookup helper. Resolves a bare model id from the
 * registry's `allowedModelIds` to the catalog row that should
 * produce it. Returns `null` when the catalog row does not
 * carry the harness's execution target on its
 * `supportedExecutionTargets` field — that is the upstream
 * gate that enforces "MiniMax CLI must not receive Codex
 * models" and vice versa.
 */
function catalogRowForHarness(
  harnessId: HarnessId,
  bareModelId: string,
): {
  modelDisplayName: string;
  capability: ReasoningCapability | null;
} | null {
  if (harnessId === "codex_cli") {
    if (!isCodexCatalogModelId(bareModelId)) return null;
    const row: CodexCatalogEntry | undefined = CODEX_CATALOG_MODELS.find(
      (m) => m.id === bareModelId,
    );
    if (!row) return null;
    // Hard gate: the catalog row must explicitly carry
    // `codex_cli` as a supported execution target. Any future
    // OpenAI model that ships without this flag is silently
    // dropped here, before it can reach the harness runner.
    if (!row.supportedExecutionTargets.includes("codex_cli")) return null;
    return {
      modelDisplayName: row.label,
      capability: row.reasoningCapability,
    };
  }
  if (harnessId === "minimax_cli") {
    const row: MiniMaxCatalogEntry | undefined = getMiniMaxModels().find(
      (m) => m.modelId === bareModelId,
    );
    if (!row) return null;
    // Same hard gate for MiniMax: the row must carry
    // `minimax_cli` as a supported execution target. The
    // current default row carries both `chat_model` and
    // `minimax_cli`, so this passes; a future chat-only
    // MiniMax row would be dropped here.
    const targets = row.supportedExecutionTargets ?? ["chat_model", "minimax_cli"];
    if (!targets.includes("minimax_cli")) return null;
    return {
      modelDisplayName: row.modelLabel,
      capability: row.reasoningCapability,
    };
  }
  // Unknown harness id — refuse to invent a pair. OpenCode / Pi
  // are placeholders only; until they have a registry entry
  // with a populated `allowedModelIds`, this branch is hit.
  return null;
}

/**
 * Coerce a candidate reasoning level for a (harness, model) pair.
 * Centralises the rule that the chat composer + the route +
 * the dispatcher must agree on:
 *
 *   - If `preferred` is one of the model's documented reasoning
 *     levels, return it verbatim.
 *   - Otherwise return the model's `defaultOption` (`"low"` for
 *     Codex, `"provider_default"` for MiniMax M3).
 *   - MiniMax CLI additionally force-coerces ANY non-
 *     `"provider_default"` value to `"provider_default"`
 *     because the CLI surface does not accept a reasoning knob
 *     today. This guards against a future Codex-style UI
 *     accidentally shipping `xhigh` to MiniMax.
 */
export function resolveReasoningLevelForPair(
  harnessId: HarnessId,
  modelId: string,
  preferredReasoningLevel?: string | null,
): { selectedReasoningLevel: string; supportedReasoningLevels: ReadonlyArray<string> } {
  const capability =
    harnessId === "codex_cli"
      ? codexCapability(modelId)
      : harnessId === "minimax_cli"
        ? minimaxCapability(modelId)
        : null;
  const supportedReasoningLevels = capability ? getEffectiveReasoningLevels(capability) : [];
  const defaultOption = (() => {
    if (!capability) return null;
    if (capability.kind === "effort_levels") return capability.defaultOption ?? "low";
    if (capability.kind === "thinking_budget") return capability.defaultMode ?? "provider_default";
    return "provider_default";
  })();
  // MiniMax CLI is the only harness with the
  // "provider_default only" contract today; we mirror that
  // even when the model advertises a richer reasoning
  // capability (e.g. M3 in the chat picker has a full
  // thinking-budget capability, but the MiniMax CLI surface
  // only accepts `provider_default`).
  if (harnessId === "minimax_cli") {
    const pref = preferredReasoningLevel?.trim();
    const selected = pref && pref === "provider_default" ? "provider_default" : "provider_default";
    return {
      selectedReasoningLevel: selected,
      supportedReasoningLevels: ["provider_default"],
    };
  }
  // Codex CLI (and any future CLI harness that does accept a
  // reasoning knob): honour the user's pick when the model
  // advertises it, otherwise fall back to the model's
  // default option, otherwise `"low"`.
  const pref = preferredReasoningLevel?.trim();
  if (pref && supportedReasoningLevels.includes(pref)) {
    return {
      selectedReasoningLevel: pref,
      supportedReasoningLevels,
    };
  }
  return {
    selectedReasoningLevel: defaultOption ?? "low",
    supportedReasoningLevels,
  };
}

/**
 * Single source of truth for "does this harness support this
 * model id?". Accepts the bare id (without `codex:` / `minimax:`
 * prefix) AND the prefixed id; both resolve to the same
 * harness-allowlist lookup.
 *
 * Returns `false` for:
 *   - Unknown harness ids (OpenCode / Pi until they have a
 *     registry row).
 *   - Codex CLI + MiniMax / non-Codex catalog ids.
 *   - MiniMax CLI + Codex / OpenAI catalog ids.
 */
export function harnessSupportsModel(
  harnessId: HarnessId | string,
  modelId: string,
): boolean {
  return harnessSupportsModelById(harnessId, modelId);
}

/**
 * Build every valid `(harness, model, reasoning)` tuple the system
 * can dispatch against RIGHT NOW. Includes entries whose harness is
 * currently `unavailable` — callers (the recommender route) decide
 * whether to surface those as degraded alternates or drop them
 * entirely. The shape is intentionally harness-status-aware so the
 * route can render `Codex token limit exhausted` next to a healthy
 * MiniMax pair without consulting the failure cache.
 */
export async function getValidCodingExecutionPairs(): Promise<ReadonlyArray<ValidCodingPair>> {
  const registry = await liveRegistry();
  const pairs: ValidCodingPair[] = [];
  for (const harness of registry) {
    for (const listedModelId of harness.allowedModelIds) {
      // The registry may carry prefixed ids (e.g. `"codex:gpt-5.4-mini"`).
      // The catalog lookup operates on bare ids, so we always
      // strip the prefix before consulting the catalog.
      const bareModelId = stripHarnessModelPrefix(listedModelId);
      const catalogRow = catalogRowForHarness(harness.id, bareModelId);
      if (!catalogRow) {
        // Hard gate. Either the model id is not in the catalog
        // (a stale registry row), or the catalog row's
        // supportedExecutionTargets do not include this harness.
        // In both cases the pair is rejected here; the route
        // never sees it.
        continue;
      }
      const { selectedReasoningLevel, supportedReasoningLevels } =
        resolveReasoningLevelForPair(harness.id, bareModelId);
      pairs.push({
        harnessId: harness.id,
        harnessDisplayName: harness.displayName,
        modelId: bareModelId,
        modelDisplayName: catalogRow.modelDisplayName,
        selectedReasoningLevel,
        supportedReasoningLevels,
        providerPath: harness.providerPath,
        billingPath: harness.billingPath,
        harnessStatus: harness.status,
        unavailableReason: harness.unavailableReason,
        requiresProjectFolder: harness.requiresProjectFolder,
        canModifyFiles: harness.canModifyFiles,
      });
    }
  }
  return pairs;
}

/**
 * Chat-path candidates. Today this is identical to the coding
 * pairs minus the harness status + the canModifyFiles /
 * requiresProjectFolder fields, but the function is exposed
 * separately so future chat surfaces (e.g. Codex recommendation
 * for a chat reply) can ask for the model-only view without
 * pulling in the harness bookkeeping.
 *
 * Note: the current chat path in `/api/chat` consults the
 * `models` registry directly via `getEffectiveModelsResponse`,
 * which is a DIFFERENT (and larger) catalog. This function is
 * kept here so future chat surfaces that should pick from the
 * same central harness-compatible set have a stable home.
 */
export async function getChatModelCandidates(): Promise<ReadonlyArray<{
  modelId: string;
  modelDisplayName: string;
  providerId: string;
  reasoningCapability: ReasoningCapability;
}>> {
  const out: Array<{
    modelId: string;
    modelDisplayName: string;
    providerId: string;
    reasoningCapability: ReasoningCapability;
  }> = [];
  for (const row of CODEX_CATALOG_MODELS) {
    out.push({
      modelId: row.id,
      modelDisplayName: row.label,
      providerId: "codex",
      reasoningCapability: row.reasoningCapability,
    });
  }
  for (const row of getMiniMaxModels()) {
    out.push({
      modelId: row.modelId,
      modelDisplayName: row.modelLabel,
      providerId: "minimax",
      reasoningCapability: row.reasoningCapability,
    });
  }
  return out;
}

/**
 * Per-harness candidates. Used by the chat composer to render the
 * "Use <other harness> instead" button — the candidate list is
 * the same shape as `getValidCodingExecutionPairs()` but filtered
 * down to one harness. Returned in catalog order so the UI
 * default select is deterministic.
 */
export async function getCodingHarnessCandidates(
  harnessId: HarnessId,
): Promise<ReadonlyArray<ValidCodingPair>> {
  const pairs = await getValidCodingExecutionPairs();
  return pairs.filter((p) => p.harnessId === harnessId);
}

/**
 * Tiny helper used by the test suite (and a couple of routes) to
 * confirm that the MiniMax CLI default model id exists in the
 * catalog — guards against accidental renames in
 * `lib/providers/minimax.ts` that would silently drop the only
 * valid MiniMax CLI pair.
 */
export function getMiniMaxCliDefaultModelId(): string {
  return MINIMAX_DEFAULT_MODEL_ID;
}