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

export type ProviderId = "openai" | "minimax" | "codex";

export type ReasoningLevel = "low" | "medium" | "high";

export type ModelTier = "cheap" | "expensive";

export type AccessPath = "openai_api" | "minimax_api" | "codex_chatgpt";

/**
 * Re-export of the per-model execution-target discriminator. The
 * canonical definition lives in `lib/providers/codex-catalog.ts`
 * (`SupportedExecutionTarget`) so the harness registry and the
 * catalog share one type. We re-export here so consumers of
 * `ModelOption` don't need a second import.
 */
export type { SupportedExecutionTarget } from "./codex-catalog";
/**
 * Coarse billing discriminator used by the no-API-billing-fallback
 * policy and by UI labels. Mirrors the `BillingType` union in
 * `lib/providers/access-control.ts` but is intentionally narrower —
 * the chat + recommender layers only need the subscription / api_billing
 * split to enforce the policy. The richer `BillingType` stays in
 * access-control for the Settings UI status display.
 */
export type BillingSource = "subscription" | "api_billing";
export type BillingLabel = "Codex subscription" | "MiniMax subscription" | "OpenAI API billing";
export type CapabilityKind = "model_provider" | "agent_backend";

/**
 * How the active model was chosen for the current run. Carried on
 * the chat request so the runtime + tests can prove a model was
 * not silently substituted. The user-facing UI uses it to show
 * "You picked this" vs "You accepted a recommendation" vs
 * "This is the project default".
 */
export type SelectionSource =
  | "user_explicit" // user picked from the chat picker
  | "user_accepted" // user accepted a recommender suggestion
  | "project_default" // project-configured default
  | "registry_default" // global registry default
  | "system_fallback"; // proposed subscription-only fallback shown to user

/**
 * Re-export the discriminated-union reasoning capability type. The
 * actual definition lives in `./capability.ts` to keep this file
 * dependency-light (callers that just need the union shape can
 * import it from either module).
 */
export type {
  EffortLevelsCapability,
  NoReasoningCapability,
  ReasoningCapability,
  ReasoningControl,
  ThinkingBudgetCapability,
  UnknownReasoningCapability,
} from "./capability";

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
   * Execution targets the harness registry may route this model id
   * to. Populated by `lib/providers/{codex-catalog,minimax}.ts` and
   * surfaced through `lib/providers/registry.ts`. The harness
   * registry uses this field to filter eligible model ids so adding
   * a new harness never requires editing the per-provider catalogs.
   *
   * Defaults are inferred by `lib/providers/registry.ts` when the
   * catalog does not provide a value:
   *   - OpenAI API models        → `["chat_model"]`
   *   - Codex catalog ids        → `["codex_cli"]`
   *   - MiniMax catalog + default M3 → `["chat_model", "minimax_cli"]`
   */
  supportedExecutionTargets: ReadonlyArray<import("./codex-catalog").SupportedExecutionTarget>;
  /**
   * True when the model supports provider-native reasoning / thinking
   * controls (`reasoning_effort` for OpenAI / Codex, `thinking` for
   * MiniMax). Mirrored on the chat-picker DTO so the chat composer
   * can hide the reasoning picker for models that do not actually
   * consume the value. The harness registry reads the same field on
   * its own entries so the approval card renders "provider default"
   * for harnesses that do not accept a level.
   */
  supportsReasoningLevels: boolean;
  /**
   * Canonical reasoning / thinking capability for this model. See
   * `lib/providers/capability.ts` for the full capability model and
   * the rules for surfacing it through the UI and the request builder.
   *
   * Always present. For unconfigured / discovered-only models this is
   * `{ kind: "unknown", control: "unknown" }` — the UI must NOT render
   * a fake effort-level dropdown for unknown capabilities.
   */
  reasoningCapability: import("./capability").ReasoningCapability;
  /**
   * Derived legacy field: the concrete list of provider-native option
   * `value`s this model advertises for its effort-level capability.
   * Populated only when `reasoningCapability.kind === "effort_levels"`
   * and `control` is `supported` or `model_dependent`. Empty for
   * thinking-budget, none, and unknown capabilities.
   *
   * The values are provider-native strings, NOT the narrow
   * `ReasoningLevel` enum — Codex `xhigh` or MiniMax `adaptive` would
   * flow through unchanged. Callers that need the full option
   * metadata (label, description) should consult
   * `reasoningCapability.options` directly.
   */
  reasoningLevels: ReadonlyArray<string>;
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
  /**
   * Coarse billing discriminator for the resolved model. Always set
   * by the runtime. The no-API-billing-fallback policy uses this to
   * reject any silent substitution of an API-billed provider for a
   * subscription-backed one.
   */
  billingSource: BillingSource;
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
  reasoningCapability: import("./capability").ReasoningCapability;
  /**
   * Derived legacy field — see `ModelOption.reasoningLevels` for the
   * rules. Kept on `ModelMeta` so callers that only have a `ModelMeta`
   * (e.g. the router policy) can still consult it without importing
   * `capability.ts`. Values are provider-native strings, not the
   * narrow `ReasoningLevel` enum.
   */
  reasoningLevels: ReadonlyArray<string>;
  /**
   * Coarse billing discriminator. Defaults to API-billed for
   * unrecognized provider ids so that callers which do not know
   * about a new provider can never accidentally mark it as
   * subscription. Use `getBillingSourceForProvider` to set this
   * correctly.
   */
  billingSource: BillingSource;
  /**
   * Execution targets the harness registry may route this model id
   * to. Optional on `ModelMeta` (older callers that construct a
   * `ModelMeta` by hand may omit it); the registry falls back to
   * `["chat_model"]` when missing.
   */
  supportedExecutionTargets?: ReadonlyArray<import("./codex-catalog").SupportedExecutionTarget>;
  /**
   * Mirrors `supportsReasoning` for the harness approval card. The
   * default for known Codex / MiniMax catalog rows is `true`;
   * OpenAI rows inherit `reasoningLevels.length > 0`. The field is
   * optional on `ModelMeta` so existing call sites compile.
   */
  supportsReasoningLevels?: boolean;
};

/**
 * Router allowlist entry — an explicit (model, reasoning-level) pair that
 * the recommender may choose. Order is meaningful only for the deterministic
 * fallback picker; the LLM is told the list verbatim and gets to pick.
 */
/**
 * Router allowlist entry — an explicit (modelId, reasoningLevel)
 * pair the router is allowed to pick. The `reasoningLevel` value is
 * provider-native (e.g. `"low"`, `"medium"`, `"xhigh"`, `"none"`)
 * and is matched against the model's `capability.options` at
 * validation time. Stale values — values that are no longer in
 * the model's options after a refresh — are rejected at save time.
 */
export type RouterAllowlistEntry = {
  modelId: string;
  reasoningLevel: string;
  tier: ModelTier;
};
