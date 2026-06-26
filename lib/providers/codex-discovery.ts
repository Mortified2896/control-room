import "server-only";

import { CODEX_CATALOG_MODELS } from "./codex-catalog";

export type CodexRefreshOutcome = {
  kind: "fresh";
  source: "codex_catalog";
  discoveryType: "static_catalog";
  modelIds: ReadonlyArray<string>;
  modelCount: number;
  requiresApiKey: false;
};

export async function refreshCodexModels(): Promise<CodexRefreshOutcome> {
  return {
    kind: "fresh",
    source: "codex_catalog",
    discoveryType: "static_catalog",
    modelIds: CODEX_CATALOG_MODELS.map((m) => m.id),
    modelCount: CODEX_CATALOG_MODELS.length,
    requiresApiKey: false,
  };
}
