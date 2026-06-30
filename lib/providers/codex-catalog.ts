import type { ModelTier } from "./types";
import type { ReasoningCapability } from "./capability";
import { effortLevelsCapability } from "./capability";

/**
 * Execution-target discriminator carried on the model metadata so the
 * harness registry can filter eligible model ids without hard-coding
 * the harness list in two places.
 *
 *   - `chat_model`  — the model can run via the standard chat path
 *                     (`/api/chat`, Side A). Default for every model.
 *   - `codex_cli`   — the model can be the target of a Codex CLI
 *                     coding task. Today every Codex catalog row
 *                     qualifies; the flag exists so future OpenAI
 *                     models that ship with Codex-side support can be
 *                     opted in without changing the harness registry.
 *   - `minimax_cli` — the model can be the target of a MiniMax CLI
 *                     coding task. The MiniMax catalog is its own
 *                     family today; this flag is reserved for cross-
 *                     surface models in the future.
 *
 * The router / recommender / harness approval card consult these flags
 * via `lib/providers/registry.ts` — never via a hard-coded model id
 * list — so adding a new harness is a one-line registry edit.
 */
export type SupportedExecutionTarget = "chat_model" | "codex_cli" | "minimax_cli";

export type CodexCatalogModel = {
  id: string;
  label: string;
  tier: ModelTier;
  mayBePlanGated: boolean;
  note?: string;
  transport: "codex-cli";
  source: "codex_catalog";
  discoveryType: "static_catalog";
  requiresApiKey: false;
  /**
   * Execution targets the Codex CLI can drive against this model id.
   * Always includes `codex_cli` for catalog entries; `chat_model`
   * is added for models that ALSO ship as a first-class chat
   * provider (none today). See `SupportedExecutionTarget`.
   */
  supportedExecutionTargets: ReadonlyArray<SupportedExecutionTarget>;
  /**
   * Whether the Codex CLI itself accepts a provider-native reasoning
   * value on the command line for this model. Always `true` for the
   * catalog; surfaced so the harness approval card can render
   * "provider default" vs. a real picker when false.
   */
  supportsReasoningLevels: boolean;
  /**
   * Honest reasoning / thinking capability for this Codex model.
   *
   * Codex CLI / config / IDE support `reasoning_effort` style controls
   * when the underlying OpenAI model supports them. We mirror the
   * documented set per-model — NOT a fixed `low | medium | high` enum.
   * Provider-native values flow through unchanged so the picker shows
   * `none`, `minimal`, and `xhigh` literally instead of hiding them.
   *
   * Static catalog entries carry `source: "static"` and `refreshedAt`
   * set to the build time. When the Codex refresh path in
   * `lib/providers/reasoning-refresh.ts` is implemented, it can
   * overwrite these with the live catalog.
   */
  reasoningCapability: ReasoningCapability;
};

const CODEX_BASE_TARGETS: ReadonlyArray<SupportedExecutionTarget> = ["codex_cli"];

export const CODEX_CATALOG_MODELS = [
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    tier: "expensive",
    mayBePlanGated: false,
    transport: "codex-cli",
    source: "codex_catalog",
    discoveryType: "static_catalog",
    requiresApiKey: false,
    supportedExecutionTargets: CODEX_BASE_TARGETS,
    supportsReasoningLevels: true,
    // Codex CLI / GPT-5.5 supports the full
    // `none | minimal | low | medium | high | xhigh` effort-level
    // set. Surface every value literally.
    reasoningCapability: effortLevelsCapability(
      ["none", "minimal", "low", "medium", "high", "xhigh"],
      "supported",
      { defaultOption: "low", source: "static" },
    ),
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    tier: "expensive",
    mayBePlanGated: false,
    transport: "codex-cli",
    source: "codex_catalog",
    discoveryType: "static_catalog",
    requiresApiKey: false,
    supportedExecutionTargets: CODEX_BASE_TARGETS,
    supportsReasoningLevels: true,
    reasoningCapability: effortLevelsCapability(
      ["none", "minimal", "low", "medium", "high", "xhigh"],
      "supported",
      { defaultOption: "low", source: "static" },
    ),
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    tier: "cheap",
    mayBePlanGated: false,
    transport: "codex-cli",
    source: "codex_catalog",
    discoveryType: "static_catalog",
    requiresApiKey: false,
    supportedExecutionTargets: CODEX_BASE_TARGETS,
    supportsReasoningLevels: true,
    // Cheap-tier model — `xhigh` is not documented for the mini
    // tier. We still surface `none` literally.
    reasoningCapability: effortLevelsCapability(["none", "low", "medium", "high"], "supported", {
      defaultOption: "low",
      source: "static",
    }),
  },
  {
    id: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    tier: "cheap",
    mayBePlanGated: true,
    note: "Research preview; may require ChatGPT Pro",
    transport: "codex-cli",
    source: "codex_catalog",
    discoveryType: "static_catalog",
    requiresApiKey: false,
    supportedExecutionTargets: CODEX_BASE_TARGETS,
    supportsReasoningLevels: true,
    // Research-preview model — exact reasoning_effort support is not
    // documented. We advertise a conservative `low` default so the UI
    // can still render a single, honest option; the runtime forwards
    // the user's pick to the Codex CLI, which is the source of truth.
    reasoningCapability: effortLevelsCapability(["low"], "model_dependent", {
      defaultOption: "low",
      source: "static",
    }),
  },
] as const satisfies ReadonlyArray<CodexCatalogModel>;

export type CodexModelId = (typeof CODEX_CATALOG_MODELS)[number]["id"];

export function isCodexCatalogModelId(value: string): value is CodexModelId {
  return CODEX_CATALOG_MODELS.some((m) => m.id === value);
}

export const CODEX_DEFAULT_MODEL_ID: CodexModelId = "gpt-5.4-mini";
