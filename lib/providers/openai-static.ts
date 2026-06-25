/**
 * Local static metadata for OpenAI models known to this build.
 *
 * Single source of truth for:
 *   - which model ids are "known" (have local metadata),
 *   - the canonical display label,
 *   - the cost tier (cheap vs expensive),
 *   - the reasoning levels the model is allowed to be paired with.
 *
 * Dynamic discovery (`lib/providers/openai-discovery.ts`) determines
 * which of these models is *available* to the configured API key.
 * `lib/providers/registry.ts` merges discovery + this table to produce the
 * effective registry consumed by the chat route and the Settings UI.
 *
 * Notes on tier assignment:
 *   - `gpt-5.4-mini` is the cheap tier and the default router model.
 *   - `gpt-5.5` is the expensive tier — opt-in via router settings.
 *   - `gpt-fake-known-extra` is a deterministic dev/Playwright-only entry
 *     that mirrors the cheap-tier metadata shape. It is only present in
 *     the alias map so the merge layer can tag it as "known" when fake
 *     discovery returns it; production builds never receive it from
 *     OpenAI's `/v1/models` endpoint.
 */
import type { ModelTier, ReasoningLevel } from "./types";

export type StaticOpenAIModelAlias = {
  label: string;
  tier: ModelTier;
  reasoningLevels: ReadonlyArray<ReasoningLevel>;
};

const OPENAI_STATIC_ALIASES: ReadonlyMap<string, StaticOpenAIModelAlias> = new Map([
  ["gpt-5.4-mini", { label: "GPT-5.4 Mini", tier: "cheap", reasoningLevels: ["low", "medium"] }],
  ["gpt-5.5", { label: "GPT-5.5", tier: "expensive", reasoningLevels: ["low", "medium", "high"] }],
  [
    "gpt-fake-known-extra",
    { label: "GPT-Fake Known Extra", tier: "cheap", reasoningLevels: ["low", "medium"] },
  ],
]);

/**
 * Iterate the static alias map in a stable order (cheap first, then
 * expensive, then unknown; alphabetical within each tier). Callers that
 * need a deterministic ordering (the registry's `defaults.manualModelId`
 * picker) should consume this rather than iterating `Map` directly.
 */
export function listStaticOpenAIModelAliases(): ReadonlyArray<
  readonly [string, StaticOpenAIModelAlias]
> {
  return [...OPENAI_STATIC_ALIASES.entries()].sort(([aId, a], [bId, b]) => {
    if (a.tier !== b.tier) return a.tier.localeCompare(b.tier);
    return aId.localeCompare(bId);
  });
}

export function getStaticOpenAIModelAlias(modelId: string): StaticOpenAIModelAlias | null {
  return OPENAI_STATIC_ALIASES.get(modelId) ?? null;
}

export function isKnownStaticOpenAIModel(modelId: string): boolean {
  return OPENAI_STATIC_ALIASES.has(modelId);
}
