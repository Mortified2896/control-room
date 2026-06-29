import type { ModelTier } from "./types";
import type { ReasoningCapability } from "./capability";
import { effortLevelsCapability } from "./capability";

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
