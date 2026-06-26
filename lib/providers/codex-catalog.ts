import type { ModelTier } from "./types";

export type CodexCatalogModel = {
  id: string;
  label: string;
  tier: ModelTier;
  mayBePlanGated: boolean;
  transport: "codex-cli";
  source: "codex_catalog";
  discoveryType: "static_catalog";
  requiresApiKey: false;
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
  },
  {
    id: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    tier: "cheap",
    mayBePlanGated: true,
    transport: "codex-cli",
    source: "codex_catalog",
    discoveryType: "static_catalog",
    requiresApiKey: false,
  },
] as const satisfies ReadonlyArray<CodexCatalogModel>;

export type CodexModelId = (typeof CODEX_CATALOG_MODELS)[number]["id"];

export function isCodexCatalogModelId(value: string): value is CodexModelId {
  return CODEX_CATALOG_MODELS.some((m) => m.id === value);
}

export const CODEX_DEFAULT_MODEL_ID: CodexModelId = "gpt-5.4-mini";
