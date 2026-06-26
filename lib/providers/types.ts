/**
 * Shared types for the model / provider registry.
 *
 * Model identity is split into two layers:
 *
 * - `ModelOption` — what the chat UI needs to render a model picker. Includes
 *   a human-readable label, an `enabled` flag (the provider may be missing an
 *   API key), and optional reasoning-level metadata so the UI can show only
 *   the levels each model actually supports.
 * - `ModelMeta` — the canonical, provider-authoritative metadata for a model
 *   id. Used by the router and by side-by-side displays. Includes the cost
 *   tier ("cheap" vs "expensive") and the explicit list of reasoning levels
 *   the model is allowed to be paired with in this build.
 *
 * `ResolveResult` mirrors the resolve-model contract that the chat route
 * already relies on. The router never calls `resolveModel` — it only uses
 * `ModelMeta` and the explicit allowlist exported from `lib/providers/index.ts`.
 */

export type ProviderId = "openai" | "minimax";

export type ReasoningLevel = "low" | "medium" | "high";

export type ModelTier = "cheap" | "expensive";

export type AccessPath = "openai_api" | "minimax_api" | "codex_chatgpt";
export type BillingLabel = "API billed" | "MiniMax token plan" | "ChatGPT subscription";
export type CapabilityKind = "model_provider" | "agent_backend";

export type ModelOption = {
  providerId: ProviderId | "codex";
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  enabled: boolean;
  reason?: string;
  accessPath: AccessPath;
  billingLabel: BillingLabel;
  capabilityKind: CapabilityKind;
  description: string;
  /**
   * Reasoning levels this model may be paired with. The router-side allowlist
   * is the intersection of (provider-known levels) ∩ (router policy) — the UI
   * uses this field to gate the reasoning-level submenu.
   */
  reasoningLevels: ReadonlyArray<ReasoningLevel>;
  /**
   * Cheap / expensive tier. Used by the router budget guard to keep expensive
   * models off the default allowlist unless explicitly enabled.
   */
  tier: ModelTier;
};

export type ModelsResponse = {
  models: ModelOption[];
  defaultModelId: string | null;
  defaultReasoningLevel: ReasoningLevel;
};

export type ResolvedModel = {
  providerId: ProviderId;
  modelId: string;
};

export type ResolveError =
  | { kind: "unknown_model"; modelId: string; allowedIds: string[] }
  | { kind: "provider_disabled"; providerId: ProviderId; reason: string }
  | { kind: "no_models_available" };

export type ResolveResult =
  | { ok: true; resolved: ResolvedModel }
  | { ok: false; error: ResolveError };

export type ModelMeta = {
  providerId: ProviderId;
  modelId: string;
  modelLabel: string;
  tier: ModelTier;
  reasoningLevels: ReadonlyArray<ReasoningLevel>;
};

/**
 * Router allowlist entry — an explicit (model, reasoning-level) pair that
 * the recommender may choose. Order is meaningful only for the deterministic
 * fallback picker; the LLM is told the list verbatim and gets to pick.
 */
export type RouterAllowlistEntry = {
  modelId: string;
  reasoningLevel: ReasoningLevel;
  tier: ModelTier;
};
