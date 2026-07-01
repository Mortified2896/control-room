/**
 * Router settings — typed, validated, env-overridable, Postgres-overridable.
 *
 * These are the runtime knobs that govern how the LangGraph router decides
 * Side B and how the safety/budget guards evaluate its output. The Settings
 * UI (`/settings/router`) writes through `parseRouterSettingsForSave`, and
 * the chat route reads the merged effective payload via
 * `lib/router/settings-store.ts`.
 *
 * Sources of truth, in priority order:
 *   1. `router_settings` singleton row in Postgres (set by the Settings UI).
 *   2. `CONTROL_ROOM_ROUTER_SETTINGS` env var (JSON).
 *   3. Built-in `DEFAULT_ROUTER_SETTINGS` below.
 *
 * Validation lives in `parseRouterSettings` (pure, throws on invalid input,
 * lenient for env-only mode) and `parseRouterSettingsForSave` (strict —
 * enforces the cross-field invariants the Settings UI must respect).
 * `getRouterSettings()` is the safe in-process accessor used when no DB
 * read is possible (it never throws; an invalid env var is logged and the
 * defaults are returned). For the chat path, `getEffectiveRouterSettings`
 * in `lib/router/settings-store.ts` reads the DB singleton and merges.
 *
 * Important: this file must be safe to import from both client and server
 * code. It only depends on `lib/providers` (which is also dependency-free)
 * and on Node's `process.env` accessor, which is fine at build time even in
 * a client bundle — Next inlines `process.env.X` reads for the client.
 *
 * ----------------------------------------------------------------------
 * UI section ownership (post split refactor — see AGENTS.md and the
 * `/settings/router` page for the user-facing surface)
 * ----------------------------------------------------------------------
 *
 * The Settings UI exposes three focused tabs/cards. Each tab owns its
 * slice of these fields; the schema keeps them coalesced into a single
 * singleton row for persistence simplicity but the UI splits them up so
 * users never have to guess which toggle affects which decision:
 *
 *   Tab A · Manual chat picker
 *     Persists via /api/model-selector-prefs (separate singleton row in
 *     `model_selector_prefs`), NOT in `RouterSettings`. The Tab A
 *     controls answer "What can I manually select?" — they include /
 *     exclude models from `/api/models` and the chat composer dropdown.
 *
 *   Tab B · Recommender engine
 *     `normalChatRecommenderModelId`             — engine model id
 *     `normalChatRecommenderReasoningLevel`      — engine reasoning/thinking
 *     `normalChatRecommenderFallbackModelId`     — optional single
 *       user-configurable engine fallback model (`null` = no
 *       user-configured fallback; primary fails → loud failure,
 *       no hidden Codex/MiniMax/OpenAI default rung).
 *     `normalChatRecommenderFallbackReasoningLevel`
 *       — reasoning/thinking level to use when the engine fallback
 *         model is the active recommender.
 *     These together answer "What model recommends?". The engine model
 *     is distinct from the candidates it may recommend: the engine reads
 *     the user prompt and picks a chat model from the Tab C candidate
 *     pool. Engine unavailable → loud failure, never silent fallback.
 *
 *   Tab C · Recommender candidates
 *     `normalChatRecommenderAllowedModels` — model allowlist
 *       (`null` = no restriction, `[]` = block all, otherwise explicit).
 *     `allowedCombos`                       — per-(model, reasoning/thinking)
 *       option allowlist. Constrains BOTH the Side B A/B router pool
 *       AND the normal chat recommender pick. The UI surfaces this as
 *       per-row reasoning/thinking checkboxes.
 *     Bulk actions:
 *       - Allow subscription standard models
 *       - Block API-billed models
 *       - Block all
 *       - Reset safe defaults
 *
 * Outside the three tabs (Router A/B legacy surface, kept for now):
 *   `routerModelId`               — A/B recommender model id (separate)
 *   `allowExpensiveModels`        — Side B global guard (auto-opened by
 *                                    `normalizeTableDrivenRouterSettings`
 *                                    so hidden persisted flags cannot
 *                                    contradict a row enabled in Tab C)
 *   `allowLongPromptWhenExpensive` — Side B long-prompt guard (also auto-
 *                                    opened)
 *   `longPromptThresholdChars`    — long-prompt cutoff
 *   `failureBehavior`             — Router A/B failure behavior
 *   `abEnabled`, `maxCost*`, `fallback*` — Side B / A/B bookkeeping
 *
 * The Settings UI does NOT introduce a fourth "Advanced registry" tab
 * for the leftover knobs in the brief — they remain where they are
 * until Router A/B itself is solved in a later pass.
 */
import { DEFAULT_REASONING_LEVEL } from "@/lib/providers/openai";
import { listRouterAllowedPool } from "@/lib/providers";

/**
 * Provider-native reasoning-effort value stored in a router allowed
 * combination. May be any of the model's advertised values —
 * `low`, `medium`, `xhigh`, `none`, etc. The router settings
 * validator checks each combo against the live registry's
 * `supportedReasoningLevels` (derived from `capability.options`) so
 * stale values are rejected at save time.
 */
export type RouterAllowedCombo = {
  modelId: string;
  reasoningLevel: string;
};

export type RouterFailureBehavior = "fail_loud" | "suggest_alternative" | "auto_fallback";

export type RouterSettings = {
  /** Master kill-switch. When false, the router never runs and Side B is skipped. */
  abEnabled: boolean;
  /**
   * Cost-safety gate for the OpenAI paid API. The router / recommender
   * can only call an OpenAI API model (e.g. `gpt-5.4-mini`, `gpt-5.5`)
   * when this flag is explicitly true. Subscription providers (Codex,
   * MiniMax) are always accepted.
   *
   * The shipped default is `false` so a fresh deploy never silently
   * burns OpenAI API budget. Users who want the cheap OpenAI API
   * router / recommender must opt in via Settings → Router.
   *
   * Runtime also consults this flag — see
   * `pickSubscriptionFirstRecommender` for the recommender fallback
   * chain and `lib/providers/access-control.ts` for the parallel
   * chat-side guard.
   */
  allowOpenAiApiRouter: boolean;
  /** When false, expensive-tier models are excluded from the router allowlist. */
  allowExpensiveModels: boolean;
  /**
   * When false, expensive-tier models are also excluded automatically once
   * the prompt crosses `longPromptThresholdChars`. This is the secondary
   * safety net that the brief calls out.
   */
  allowLongPromptWhenExpensive: boolean;
  /** Character count past which we treat the prompt as "long" for safety. */
  longPromptThresholdChars: number;
  /** If the router call itself would cost more than this, fall back. */
  maxCostPerRecommendationUsd: number;
  /** If Side A + Side B combined would cost more than this, skip Side B. */
  maxCostPerAbRunUsd: number;
  /** Model id the router uses for its own recommendation call. */
  routerModelId: string;
  /**
   * Model id used for the *normal chat* recommendation — the cheap model
   * the user-facing "recommend model" toggle consults when picking which
   * chat model to answer with. This is separate from `routerModelId`
   * (which is used by the Side B A/B router and is OpenAI-only) and
   * separate from the manual model selector.
   *
   * Default: `"codex:gpt-5.4-mini"` (Codex subscription).
   * The recommender chain is exactly two rungs: the configured primary
   * and, if set, the configured fallback. If both fail the recommender
   * returns a loud failure — no hidden Codex/MiniMax/OpenAI default
   * rung, no silent model substitution, no automatic API-billed run.
   */
  normalChatRecommenderModelId: string;
  /**
   * Optional single-model fallback for the normal-chat recommender
   * engine. When set, it is tried right after the configured primary
   * fails. `null` (default) = no user-configured fallback; the chain
   * is only the primary. If the primary fails, the recommender
   * returns a loud failure — no hidden third rung, no automatic model
   * substitution, no API-billed run without explicit opt-in.
   *
   * Cost-safety:
   *   - Subscription providers (Codex, MiniMax) are always accepted.
   *   - OpenAI API models require `allowOpenAiApiRouter === true`.
   *   - May equal `normalChatRecommenderModelId` (the chain dedupes).
   *
   * Surfaced in the Settings UI under the engine model picker
   * (Settings → Router → Tab B → "Fallback engine model"). The chat
   * surface does NOT mirror this value inline; the
   * recommendation-fallback knob is a deliberate admin-time choice,
   * not a per-send one. The chat composer only reads the configured
   * value (via the lightweight `/api/router/settings` GET) to render
   * the failure-card copy in the recommendation banner.
   */
  normalChatRecommenderFallbackModelId: string | null;
  /**
   * Reasoning level passed to the recommender FALLBACK model itself
   * when it is the active recommender (i.e. when
   * `normalChatRecommenderFallbackModelId` is the model that ended
   * up running). Mirrors `normalChatRecommenderReasoningLevel` but
   * for the fallback. Must be null when
   * `normalChatRecommenderFallbackModelId` is null. The runtime
   * adapter validates the value against the fallback model's
   * `reasoningCapability.options` at call time, just like the
   * primary level.
   */
  normalChatRecommenderFallbackReasoningLevel: string | null;
  /**
   * Reasoning level passed to the recommender model itself (not to the
   * chat model the recommender suggests). Only honored when the
   * recommender model is an OpenAI API model — Codex / MiniMax
   * providers ignore reasoning controls at runtime (see
   * `getRuntimeProviderOptions`). Default `"low"` keeps the recommender
   * cheap; bump to `"medium"` or `"xhigh"` (or any other
   * provider-native value the recommender accepts) when you want
   * the recommender to think harder about which chat model to
   * pick.
   *
   * Surface in the Settings UI next to the
   * `normalChatRecommenderModelId` picker (Settings → Router → Tab B
   * → "Engine reasoning / thinking"). The chat surface does NOT
   * mirror this value inline; engine reasoning is a deliberate
   * admin-time choice. The chat composer only reads the configured
   * value to render the failure-card copy. The value is
   * provider-native — the recommender forwards it verbatim and the
   * runtime adapter validates against the recommender model's
   * `reasoningCapability.options`.
   */
  normalChatRecommenderReasoningLevel: string;
  /** What happens when a selected/recommended combo cannot run. Defaults to fail-loud. */
  failureBehavior: RouterFailureBehavior;
  /** Legacy only: retained for persisted payload compatibility; not used unless auto_fallback is enabled. */
  fallbackModelId: string;
  /** Legacy only: retained for persisted payload compatibility; not used unless auto_fallback is enabled. */
  fallbackReasoningLevel: string;
  /**
   * Explicit (modelId, reasoningLevel) pairs the user has authorized the
   * router to choose from. The dynamic allowlist is the intersection of
   * this list, the registry-derived pool (tier filter), and the long-prompt
   * safety guard.
   *
   * This list is the user-facing surface of the Settings UI: every
   * (model, reasoning-level) combo shown there is checked or unchecked
   * individually. `DEFAULT_ROUTER_SETTINGS.allowedCombos` ships with every
   * cheap-tier combo enabled so the MVP keeps working before the UI has
   * ever been opened.
   */
  allowedCombos: ReadonlyArray<RouterAllowedCombo>;
  /**
   * User-curated allowlist of model ids the *normal-chat recommender*
   * may recommend to the user. This is the pool from which the
   * recommender picks when a chat send goes through the "Recommend
   * model" flow.
   *
   * Semantics:
   *   - `null` (default): no restriction. Every enabled model that is
   *     not Codex (the recommender already excludes Codex from its
   *     prompt because Codex is an agent backend, not a chat model)
   *     is eligible.
   *   - `[]`: no models allowed. The recommender will fail loud and
   *     the banner will tell the user "no models enabled for the
   *     recommender".
   *   - `["gpt-5.4-mini", "MiniMax-M3"]`: only these model ids are
   *     eligible. Unknown ids are silently dropped at runtime so the
   *     recommender never recommends a model the user can't actually
   *     call.
   *
   * This is the user-facing surface of the Settings UI. The Model
   * Registry table exposes one Switch per row (mirroring the Manual
   * and Router columns), and the Router Global Settings section
   * shows a summary + `Allow all enabled` / `Block all` buttons.
   */
  normalChatRecommenderAllowedModels: ReadonlyArray<string> | null;
  /**
   * Token count past which the long-prompt recommender lane is used.
   * Lane selection is deterministic by token estimate; the selected
   * lane's recommender engine then chooses the execution model.
   * Default: 120,000 tokens.
   */
  longPromptThresholdTokens: number;
  /**
   * Long-prompt-lane primary recommender model id. Used when request
   * token estimate is at or above `longPromptThresholdTokens`.
   * The recommender engine is NOT an execution default — it only
   * recommends. Execution model comes from recommender output.
   */
  longPromptRecommenderModelId: string;
  /** Reasoning/thinking level for the long-prompt-lane primary recommender. */
  longPromptRecommenderReasoningLevel: string;
  /**
   * Long-prompt-lane paired fallback recommender model. `null` = no
   * fallback; primary fails → loud failure, no hidden default rung.
   */
  longPromptRecommenderFallbackModelId: string | null;
  /** Reasoning/thinking level for the long-prompt-lane fallback recommender. */
  longPromptRecommenderFallbackReasoningLevel: string | null;
};

/**
 * Default authorized combos. Cost-safety first: ship with every
 * Codex (subscription) entry across all their supported reasoning
 * levels so a fresh deploy never falls back to the OpenAI paid API.
 * The OpenAI API is opt-in via `allowOpenAiApiRouter`.
 *
 * Codex models are always configured, available, and support reasoning
 * controls (their `effort_levels` capability is the source of truth
 * for which levels are supported per-model). The `reasoningLevel`
 * value below is validated against each model's
 * `supportedReasoningLevels` at save time — only provider-native
 * levels that the model genuinely supports are accepted.
 *
 * All Codex catalog models (gpt-5.5, gpt-5.4, gpt-5.4-mini,
 * gpt-5.3-codex-spark) are included with ALL their supported
 * reasoning levels so the Settings UI renders every checkbox as
 * checked by default and users do not have to manually opt into
 * each level on first boot.
 *
 * Per-model supported levels (from `lib/providers/codex-catalog.ts`):
 *   codex:gpt-5.5              → none, minimal, low, medium, high, xhigh
 *   codex:gpt-5.4              → none, minimal, low, medium, high, xhigh
 *   codex:gpt-5.4-mini         → none, low, medium, high
 *   codex:gpt-5.3-codex-spark → low (model_dependent; conservative)
 */
const DEFAULT_ALLOWED_COMBOS: ReadonlyArray<RouterAllowedCombo> = [
  // gpt-5.5 — full effort-level surface
  { modelId: "codex:gpt-5.5", reasoningLevel: "none" },
  { modelId: "codex:gpt-5.5", reasoningLevel: "minimal" },
  { modelId: "codex:gpt-5.5", reasoningLevel: "low" },
  { modelId: "codex:gpt-5.5", reasoningLevel: "medium" },
  { modelId: "codex:gpt-5.5", reasoningLevel: "high" },
  { modelId: "codex:gpt-5.5", reasoningLevel: "xhigh" },
  // gpt-5.4 — full effort-level surface
  { modelId: "codex:gpt-5.4", reasoningLevel: "none" },
  { modelId: "codex:gpt-5.4", reasoningLevel: "minimal" },
  { modelId: "codex:gpt-5.4", reasoningLevel: "low" },
  { modelId: "codex:gpt-5.4", reasoningLevel: "medium" },
  { modelId: "codex:gpt-5.4", reasoningLevel: "high" },
  { modelId: "codex:gpt-5.4", reasoningLevel: "xhigh" },
  // gpt-5.4-mini — cheap tier; xhigh not documented
  { modelId: "codex:gpt-5.4-mini", reasoningLevel: "none" },
  { modelId: "codex:gpt-5.4-mini", reasoningLevel: "low" },
  { modelId: "codex:gpt-5.4-mini", reasoningLevel: "medium" },
  { modelId: "codex:gpt-5.4-mini", reasoningLevel: "high" },
  // gpt-5.3-codex-spark — research preview; model_dependent; conservative
  { modelId: "codex:gpt-5.3-codex-spark", reasoningLevel: "low" },
];

export const DEFAULT_ROUTER_SETTINGS: RouterSettings = {
  abEnabled: false,
  // OpenAI paid API is OFF by default. The shipped defaults only use
  // subscription providers (Codex) so a fresh deploy never burns paid
  // API budget. Users must opt in via Settings → Router to add an
  // OpenAI API recommender / router.
  allowOpenAiApiRouter: false,
  allowExpensiveModels: false,
  allowLongPromptWhenExpensive: false,
  longPromptThresholdChars: 50000,
  maxCostPerRecommendationUsd: 0.03,
  maxCostPerAbRunUsd: 0.3,
  // Codex first (subscription). The runtime recommender walks:
  // configured → optional user-configured fallback → Codex → MiniMax
  // → OpenAI API (only if `allowOpenAiApiRouter === true`).
  routerModelId: "codex:gpt-5.4-mini",
  // Same subscription-first default for the normal-chat recommender so a
  // fresh deploy never silently burns paid OpenAI API budget.
  normalChatRecommenderModelId: "codex:gpt-5.4-mini",
  // No user-configured fallback by default — the chain is only
  // the primary. If it fails, the recommender returns a loud failure.
  // No hidden Codex/MiniMax/OpenAI default rung.
  normalChatRecommenderFallbackModelId: null,
  normalChatRecommenderFallbackReasoningLevel: null,
  // Long-prompt-lane recommender defaults (same as default lane).
  longPromptThresholdTokens: 120_000,
  longPromptRecommenderModelId: "codex:gpt-5.4-mini",
  longPromptRecommenderReasoningLevel: DEFAULT_REASONING_LEVEL,
  longPromptRecommenderFallbackModelId: null,
  longPromptRecommenderFallbackReasoningLevel: null,
  // Cheap-by-default reasoning for the recommender itself.
  normalChatRecommenderReasoningLevel: DEFAULT_REASONING_LEVEL,
  failureBehavior: "fail_loud",
  fallbackModelId: "codex:gpt-5.4-mini",
  fallbackReasoningLevel: DEFAULT_REASONING_LEVEL,
  allowedCombos: DEFAULT_ALLOWED_COMBOS,
  // Default: no restriction. Every enabled non-Codex model is
  // eligible for the recommender. The Settings UI lets the user
  // narrow this to a specific subset.
  normalChatRecommenderAllowedModels: null,
};

/**
 * The pre-fix stale default for `allowedCombos`.
 *
 * Before this fix, `DEFAULT_ALLOWED_COMBOS` shipped only:
 *   `{ modelId: "codex:gpt-5.4-mini", reasoningLevel: "low" }`
 *
 * Any DB row that has EXACTLY this as its `allowedCombos` is the
 * untouched stale default from before the fix — NOT a user-customized
 * policy. We migrate it to the new safe defaults.
 *
 * Any other `allowedCombos` (a different single combo, multiple combos,
 * or any non-Codex entries) is treated as a user-customized policy
 * and is NOT migrated.
 */
const STALE_LEGACY_DEFAULT_ALLOWED_COMBOS: ReadonlyArray<RouterAllowedCombo> = [
  { modelId: "codex:gpt-5.4-mini", reasoningLevel: "low" },
];

function allowedCombosEqualsStaleLegacyDefault(
  combos: ReadonlyArray<RouterAllowedCombo>,
): boolean {
  if (combos.length !== STALE_LEGACY_DEFAULT_ALLOWED_COMBOS.length) return false;
  const a = combos.map((c) => `${c.modelId}|${c.reasoningLevel}`).sort();
  const b = STALE_LEGACY_DEFAULT_ALLOWED_COMBOS.map((c) => `${c.modelId}|${c.reasoningLevel}`).sort();
  return a.every((v, i) => v === b[i]);
}

/**
 * One-time migration: if `allowedCombos` is the old stale default, replace
 * it with the new safe defaults (all Codex models × all supported reasoning
 * levels). Otherwise return unchanged.
 *
 * This migration is idempotent — once the DB has new defaults, subsequent
 * calls are no-ops (the condition never matches).
 *
 * Applied in two places:
 *   1. GET handler — migrates stale DB on first load after deploy
 *   2. PUT handler — guards against PUT body that somehow still sends
 *      the stale default (belt-and-suspenders)
 *
 * Custom user policies are NOT touched — they are preserved exactly.
 */
export function migrateStaleAllowedCombos(
  settings: RouterSettings,
): RouterSettings {
  if (!allowedCombosEqualsStaleLegacyDefault(settings.allowedCombos)) {
    return settings;
  }
  return { ...settings, allowedCombos: DEFAULT_ALLOWED_COMBOS };
}

/**
 * Provider-native reasoning-effort value. May be any of the model's
 * advertised values (`"low"`, `"medium"`, `"xhigh"`, `"none"`, …)
 * — we do NOT narrow to the historical `"low" | "medium" | "high"`
 * triple.
 */
export type RouterReasoningValue = string;

/**
 * Test whether a value is a non-empty string. The full per-model
 * validation happens in `parseRouterSettingsForSave` against the
 * registry's advertised option set.
 */
function isProviderNativeReasoningValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFailureBehavior(value: unknown): value is RouterFailureBehavior {
  return value === "fail_loud" || value === "suggest_alternative" || value === "auto_fallback";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Detect model ids that belong to a non-OpenAI provider surface.
 * Used by the validator + recommender for diagnostics only — we do
 * NOT reject subscription providers here, since the policy is to
 * accept them by default.
 *
 *   `codex:*`            → Codex CLI / ChatGPT login (codex provider)
 *   `minimax:*`          → MiniMax API key (minimax provider)
 *   `MiniMax-*`          → bare MiniMax model ids (default + discovered)
 */
export function providerIdFromModelId(modelId: string): "openai" | "codex" | "minimax" | null {
  if (modelId.startsWith("codex:")) return "codex";
  if (modelId.startsWith("minimax:") || modelId.startsWith("MiniMax-")) return "minimax";
  // Bare ids without a provider prefix are OpenAI API by convention
  // (e.g. `gpt-5.4-mini`, `gpt-5.5`). Gated behind `allowOpenAiApiRouter`.
  return "openai";
}

/**
 * Strict validation for the Settings UI save path.
 *
 * Cross-field invariants:
 *   - `allowedCombos` must be a non-empty array of unique, model-valid
 *     (modelId, reasoningLevel) pairs from the registry.
 *   - `fallbackModelId` + `fallbackReasoningLevel` must be one of the
 *     entries in `allowedCombos`.
 *   - `longPromptThresholdChars` must be a non-negative finite number.
 *
 * Returns `{ ok: true, value }` on success or `{ ok: false, errors }` with
 * a per-field error map on failure. Pure / no I/O.
 */
export type RouterSettingsValidationError = {
  field: string;
  message: string;
};

export type RouterSettingsValidationResult =
  | { ok: true; value: RouterSettings }
  | { ok: false; errors: ReadonlyArray<RouterSettingsValidationError> };

/**
 * Parse a candidate settings payload into a validated `RouterSettings`.
 * Throws `Error` on invalid input — callers should catch and fall back to
 * defaults. This is the lenient parser used by the env-var path; it does
 * not enforce the cross-field invariants the Settings UI must respect
 * (those are checked in `parseRouterSettingsForSave`).
 */
export function parseRouterSettings(input: unknown): RouterSettings {
  if (!isPlainObject(input)) {
    throw new Error("settings payload must be a JSON object");
  }
  const out: RouterSettings = { ...DEFAULT_ROUTER_SETTINGS };

  if (input.abEnabled !== undefined) {
    if (typeof input.abEnabled !== "boolean") throw new Error("abEnabled must be boolean");
    out.abEnabled = input.abEnabled;
  }
  if (input.allowExpensiveModels !== undefined) {
    if (typeof input.allowExpensiveModels !== "boolean") {
      throw new Error("allowExpensiveModels must be boolean");
    }
    out.allowExpensiveModels = input.allowExpensiveModels;
  }
  if (input.allowLongPromptWhenExpensive !== undefined) {
    if (typeof input.allowLongPromptWhenExpensive !== "boolean") {
      throw new Error("allowLongPromptWhenExpensive must be boolean");
    }
    out.allowLongPromptWhenExpensive = input.allowLongPromptWhenExpensive;
  }
  if (input.longPromptThresholdChars !== undefined) {
    if (
      typeof input.longPromptThresholdChars !== "number" ||
      !Number.isFinite(input.longPromptThresholdChars) ||
      input.longPromptThresholdChars < 0
    ) {
      throw new Error("longPromptThresholdChars must be a non-negative finite number");
    }
    out.longPromptThresholdChars = input.longPromptThresholdChars;
  }
  if (input.maxCostPerRecommendationUsd !== undefined) {
    if (
      typeof input.maxCostPerRecommendationUsd !== "number" ||
      !Number.isFinite(input.maxCostPerRecommendationUsd) ||
      input.maxCostPerRecommendationUsd < 0
    ) {
      throw new Error("maxCostPerRecommendationUsd must be a non-negative finite number");
    }
    out.maxCostPerRecommendationUsd = input.maxCostPerRecommendationUsd;
  }
  if (input.maxCostPerAbRunUsd !== undefined) {
    if (
      typeof input.maxCostPerAbRunUsd !== "number" ||
      !Number.isFinite(input.maxCostPerAbRunUsd) ||
      input.maxCostPerAbRunUsd < 0
    ) {
      throw new Error("maxCostPerAbRunUsd must be a non-negative finite number");
    }
    out.maxCostPerAbRunUsd = input.maxCostPerAbRunUsd;
  }
  if (input.routerModelId !== undefined) {
    if (typeof input.routerModelId !== "string" || input.routerModelId.trim().length === 0) {
      throw new Error("routerModelId must be a non-empty string");
    }
    out.routerModelId = input.routerModelId.trim();
  }
  if (input.normalChatRecommenderModelId !== undefined) {
    if (
      typeof input.normalChatRecommenderModelId !== "string" ||
      input.normalChatRecommenderModelId.trim().length === 0
    ) {
      throw new Error("normalChatRecommenderModelId must be a non-empty string");
    }
    out.normalChatRecommenderModelId = input.normalChatRecommenderModelId.trim();
  }
  if (input.normalChatRecommenderReasoningLevel !== undefined) {
    if (!isProviderNativeReasoningValue(input.normalChatRecommenderReasoningLevel)) {
      throw new Error(
        "normalChatRecommenderReasoningLevel must be a non-empty provider-native value (e.g. 'low', 'medium', 'xhigh')",
      );
    }
    out.normalChatRecommenderReasoningLevel = input.normalChatRecommenderReasoningLevel;
  }
  if (input.normalChatRecommenderFallbackModelId !== undefined) {
    if (input.normalChatRecommenderFallbackModelId === null) {
      out.normalChatRecommenderFallbackModelId = null;
    } else if (
      typeof input.normalChatRecommenderFallbackModelId !== "string" ||
      input.normalChatRecommenderFallbackModelId.trim().length === 0
    ) {
      throw new Error("normalChatRecommenderFallbackModelId must be null or a non-empty string");
    } else {
      out.normalChatRecommenderFallbackModelId = input.normalChatRecommenderFallbackModelId.trim();
    }
  }
  if (input.normalChatRecommenderFallbackReasoningLevel !== undefined) {
    if (input.normalChatRecommenderFallbackReasoningLevel === null) {
      out.normalChatRecommenderFallbackReasoningLevel = null;
    } else if (!isProviderNativeReasoningValue(input.normalChatRecommenderFallbackReasoningLevel)) {
      throw new Error(
        "normalChatRecommenderFallbackReasoningLevel must be null or a non-empty provider-native value (e.g. 'low', 'medium', 'xhigh')",
      );
    } else {
      out.normalChatRecommenderFallbackReasoningLevel =
        input.normalChatRecommenderFallbackReasoningLevel;
    }
  }
  // Long-prompt-lane fields
  if (input.longPromptThresholdTokens !== undefined) {
    if (
      typeof input.longPromptThresholdTokens !== "number" ||
      !Number.isFinite(input.longPromptThresholdTokens) ||
      input.longPromptThresholdTokens < 1
    ) {
      throw new Error("longPromptThresholdTokens must be a positive number");
    }
    out.longPromptThresholdTokens = Math.floor(input.longPromptThresholdTokens);
  }
  if (input.longPromptRecommenderModelId !== undefined) {
    if (
      typeof input.longPromptRecommenderModelId !== "string" ||
      input.longPromptRecommenderModelId.trim().length === 0
    ) {
      throw new Error("longPromptRecommenderModelId must be a non-empty string");
    }
    out.longPromptRecommenderModelId = input.longPromptRecommenderModelId.trim();
  }
  if (input.longPromptRecommenderReasoningLevel !== undefined) {
    if (!isProviderNativeReasoningValue(input.longPromptRecommenderReasoningLevel)) {
      throw new Error(
        "longPromptRecommenderReasoningLevel must be a non-empty provider-native value (e.g. 'low', 'medium', 'xhigh')",
      );
    }
    out.longPromptRecommenderReasoningLevel = input.longPromptRecommenderReasoningLevel;
  }
  if (input.longPromptRecommenderFallbackModelId !== undefined) {
    if (input.longPromptRecommenderFallbackModelId === null) {
      out.longPromptRecommenderFallbackModelId = null;
    } else if (
      typeof input.longPromptRecommenderFallbackModelId !== "string" ||
      input.longPromptRecommenderFallbackModelId.trim().length === 0
    ) {
      throw new Error("longPromptRecommenderFallbackModelId must be null or a non-empty string");
    } else {
      out.longPromptRecommenderFallbackModelId = input.longPromptRecommenderFallbackModelId.trim();
    }
  }
  if (input.longPromptRecommenderFallbackReasoningLevel !== undefined) {
    if (input.longPromptRecommenderFallbackReasoningLevel === null) {
      out.longPromptRecommenderFallbackReasoningLevel = null;
    } else if (!isProviderNativeReasoningValue(input.longPromptRecommenderFallbackReasoningLevel)) {
      throw new Error(
        "longPromptRecommenderFallbackReasoningLevel must be null or a non-empty provider-native value (e.g. 'low', 'medium', 'xhigh')",
      );
    } else {
      out.longPromptRecommenderFallbackReasoningLevel =
        input.longPromptRecommenderFallbackReasoningLevel;
    }
  }
  if (input.failureBehavior !== undefined) {
    if (!isFailureBehavior(input.failureBehavior)) {
      throw new Error(
        "failureBehavior must be one of 'fail_loud' | 'suggest_alternative' | 'auto_fallback'",
      );
    }
    out.failureBehavior = input.failureBehavior;
  }
  if (input.fallbackModelId !== undefined) {
    if (typeof input.fallbackModelId !== "string" || input.fallbackModelId.trim().length === 0) {
      throw new Error("fallbackModelId must be a non-empty string");
    }
    out.fallbackModelId = input.fallbackModelId.trim();
  }
  if (input.fallbackReasoningLevel !== undefined) {
    if (!isProviderNativeReasoningValue(input.fallbackReasoningLevel)) {
      throw new Error(
        "fallbackReasoningLevel must be a non-empty provider-native value (e.g. 'low', 'medium', 'xhigh')",
      );
    }
    out.fallbackReasoningLevel = input.fallbackReasoningLevel;
  }
  if (input.allowedCombos !== undefined) {
    if (!Array.isArray(input.allowedCombos)) {
      throw new Error("allowedCombos must be an array");
    }
    const combos: RouterAllowedCombo[] = [];
    for (const raw of input.allowedCombos) {
      if (!isPlainObject(raw)) throw new Error("each allowedCombos entry must be an object");
      const modelId = raw.modelId;
      const reasoningLevel = raw.reasoningLevel;
      if (typeof modelId !== "string" || modelId.trim().length === 0) {
        throw new Error("allowedCombos[].modelId must be a non-empty string");
      }
      if (!isProviderNativeReasoningValue(reasoningLevel)) {
        throw new Error(
          "allowedCombos[].reasoningLevel must be a non-empty provider-native value (e.g. 'low', 'medium', 'xhigh')",
        );
      }
      combos.push({ modelId: modelId.trim(), reasoningLevel });
    }
    out.allowedCombos = combos;
  }
  if (input.normalChatRecommenderAllowedModels !== undefined) {
    if (input.normalChatRecommenderAllowedModels === null) {
      out.normalChatRecommenderAllowedModels = null;
    } else if (Array.isArray(input.normalChatRecommenderAllowedModels)) {
      const ids: string[] = [];
      for (const raw of input.normalChatRecommenderAllowedModels) {
        if (typeof raw !== "string" || raw.trim().length === 0) {
          throw new Error(
            "normalChatRecommenderAllowedModels must be null or an array of non-empty strings",
          );
        }
        ids.push(raw.trim());
      }
      out.normalChatRecommenderAllowedModels = ids;
    } else {
      throw new Error("normalChatRecommenderAllowedModels must be null or an array");
    }
  }

  return out;
}

/**
 * Strict, cross-field validator used by the Settings UI save path.
 *
 * Throws are awkward for the UI, which wants to surface multiple field
 * errors at once and keep the user's in-progress values. So this
 * function returns a discriminated union instead.
 *
 * Recognized cross-field invariants (in addition to the per-field checks
 * done by `parseRouterSettings`):
 *
 *   1. `allowedCombos` must be non-empty.
 *   2. Every entry in `allowedCombos` must reference a model registered in
 *      `lib/providers` so the router graph can resolve metadata for it.
 *   3. `fallbackModelId` + `fallbackReasoningLevel` must be an entry in
 *      `allowedCombos`.
 *   4. `longPromptThresholdChars` is permitted to be `null` or omitted
 *      (which the UI uses as "blank"), in which case the default value is
 *      applied. A numeric value must be non-negative and finite.
 *   5. No duplicate (modelId, reasoningLevel) pairs in `allowedCombos`.
 *
 * When an `EffectiveRegistry` is supplied (the production path),
 * allowlist validation also enforces:
 *   - the model id is known to the local registry,
 *   - the model belongs to the OpenAI provider (Codex / MiniMax are
 *     rejected — this is the OpenAI-only normal-chat router),
 *   - the model is configured in the local static alias map, and
 *   - the reasoning level is in the model's supported set.
 *
 * The `available` / `stale` flags on the registry reflect OpenAI's
 * live `/v1/models` discovery snapshot. We intentionally do NOT use
 * them as a save-time gate, because the chat path (`/api/chat`) and
 * the model recommender (`/api/model/recommend`) both go through
 * `resolveModel` (see `lib/providers/index.ts`), which checks the
 * static alias map plus `OPENAI_API_KEY` — never the discovery
 * snapshot. Aligning the validator with that same source of truth
 * prevents a stale or partial discovery snapshot from silently
 * rejecting a persisted, working configuration. Runtime call failures
 * (model removed by OpenAI between snapshots, etc.) are surfaced by
 * the AI SDK at chat time and by the existing router diagnostics.
 *
 * When no registry is supplied (the env-only / test path), the legacy
 * `listRouterAllowedPool(true)` set is used. This preserves the
 * existing `lib/router/settings.test.ts` assertions.
 */
export function parseRouterSettingsForSave(
  input: unknown,
  registry?: import("@/lib/providers/registry").EffectiveRegistry,
): RouterSettingsValidationResult {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ field: "_root", message: "settings payload must be a JSON object" }],
    };
  }
  const errors: RouterSettingsValidationError[] = [];
  const b = input;

  // Stage 1: per-field checks (independent for each field so the UI can
  // show all of them at once, with no surprises about which one was
  // thrown first). Unknown fields are simply ignored.
  let abEnabled = DEFAULT_ROUTER_SETTINGS.abEnabled;
  if (b.abEnabled !== undefined) {
    if (typeof b.abEnabled === "boolean") abEnabled = b.abEnabled;
    else errors.push({ field: "abEnabled", message: "abEnabled must be a boolean." });
  }

  // `allowOpenAiApiRouter` defaults to false so a fresh deploy never
  // burns paid OpenAI API budget. The Settings UI must surface this
  // toggle so users opt in deliberately.
  let allowOpenAiApiRouter = DEFAULT_ROUTER_SETTINGS.allowOpenAiApiRouter;
  if (b.allowOpenAiApiRouter !== undefined) {
    if (typeof b.allowOpenAiApiRouter === "boolean") {
      allowOpenAiApiRouter = b.allowOpenAiApiRouter;
    } else {
      errors.push({
        field: "allowOpenAiApiRouter",
        message: "allowOpenAiApiRouter must be a boolean.",
      });
    }
  }

  let allowExpensiveModels = DEFAULT_ROUTER_SETTINGS.allowExpensiveModels;
  if (b.allowExpensiveModels !== undefined) {
    if (typeof b.allowExpensiveModels === "boolean") allowExpensiveModels = b.allowExpensiveModels;
    else
      errors.push({
        field: "allowExpensiveModels",
        message: "allowExpensiveModels must be a boolean.",
      });
  }

  let allowLongPromptWhenExpensive = DEFAULT_ROUTER_SETTINGS.allowLongPromptWhenExpensive;
  if (b.allowLongPromptWhenExpensive !== undefined) {
    if (typeof b.allowLongPromptWhenExpensive === "boolean") {
      allowLongPromptWhenExpensive = b.allowLongPromptWhenExpensive;
    } else {
      errors.push({
        field: "allowLongPromptWhenExpensive",
        message: "allowLongPromptWhenExpensive must be a boolean.",
      });
    }
  }

  let longPromptThresholdChars = DEFAULT_ROUTER_SETTINGS.longPromptThresholdChars;
  if (b.longPromptThresholdChars !== undefined && b.longPromptThresholdChars !== null) {
    const raw = b.longPromptThresholdChars;
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      longPromptThresholdChars = Math.floor(raw);
    } else {
      errors.push({
        field: "longPromptThresholdChars",
        message: "Long prompt threshold must be 0 or a positive number (or blank).",
      });
    }
  }

  let maxCostPerRecommendationUsd = DEFAULT_ROUTER_SETTINGS.maxCostPerRecommendationUsd;
  if (b.maxCostPerRecommendationUsd !== undefined) {
    const raw = b.maxCostPerRecommendationUsd;
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      maxCostPerRecommendationUsd = raw;
    } else {
      errors.push({
        field: "maxCostPerRecommendationUsd",
        message: "maxCostPerRecommendationUsd must be a non-negative finite number.",
      });
    }
  }

  let maxCostPerAbRunUsd = DEFAULT_ROUTER_SETTINGS.maxCostPerAbRunUsd;
  if (b.maxCostPerAbRunUsd !== undefined) {
    const raw = b.maxCostPerAbRunUsd;
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      maxCostPerAbRunUsd = raw;
    } else {
      errors.push({
        field: "maxCostPerAbRunUsd",
        message: "maxCostPerAbRunUsd must be a non-negative finite number.",
      });
    }
  }

  let routerModelId = DEFAULT_ROUTER_SETTINGS.routerModelId;
  if (b.routerModelId !== undefined) {
    if (typeof b.routerModelId === "string" && b.routerModelId.trim().length > 0) {
      routerModelId = b.routerModelId.trim();
    } else {
      errors.push({ field: "routerModelId", message: "routerModelId must be a non-empty string." });
    }
  }

  let normalChatRecommenderModelId = DEFAULT_ROUTER_SETTINGS.normalChatRecommenderModelId;
  if (b.normalChatRecommenderModelId !== undefined) {
    if (
      typeof b.normalChatRecommenderModelId === "string" &&
      b.normalChatRecommenderModelId.trim().length > 0
    ) {
      normalChatRecommenderModelId = b.normalChatRecommenderModelId.trim();
    } else {
      errors.push({
        field: "normalChatRecommenderModelId",
        message: "normalChatRecommenderModelId must be a non-empty string.",
      });
    }
  }

  let normalChatRecommenderReasoningLevel: string =
    DEFAULT_ROUTER_SETTINGS.normalChatRecommenderReasoningLevel;
  if (b.normalChatRecommenderReasoningLevel !== undefined) {
    if (isProviderNativeReasoningValue(b.normalChatRecommenderReasoningLevel)) {
      normalChatRecommenderReasoningLevel = b.normalChatRecommenderReasoningLevel;
    } else {
      errors.push({
        field: "normalChatRecommenderReasoningLevel",
        message:
          "normalChatRecommenderReasoningLevel must be a non-empty provider-native value (e.g. 'low', 'medium', 'xhigh').",
      });
    }
  }

  let normalChatRecommenderFallbackModelId: string | null =
    DEFAULT_ROUTER_SETTINGS.normalChatRecommenderFallbackModelId;
  if (b.normalChatRecommenderFallbackModelId !== undefined) {
    if (b.normalChatRecommenderFallbackModelId === null) {
      normalChatRecommenderFallbackModelId = null;
    } else if (
      typeof b.normalChatRecommenderFallbackModelId === "string" &&
      b.normalChatRecommenderFallbackModelId.trim().length > 0
    ) {
      normalChatRecommenderFallbackModelId = b.normalChatRecommenderFallbackModelId.trim();
    } else {
      errors.push({
        field: "normalChatRecommenderFallbackModelId",
        message: "normalChatRecommenderFallbackModelId must be null or a non-empty string.",
      });
    }
  }

  let normalChatRecommenderFallbackReasoningLevel: string | null =
    DEFAULT_ROUTER_SETTINGS.normalChatRecommenderFallbackReasoningLevel;
  if (b.normalChatRecommenderFallbackReasoningLevel !== undefined) {
    if (b.normalChatRecommenderFallbackReasoningLevel === null) {
      normalChatRecommenderFallbackReasoningLevel = null;
    } else if (isProviderNativeReasoningValue(b.normalChatRecommenderFallbackReasoningLevel)) {
      normalChatRecommenderFallbackReasoningLevel = b.normalChatRecommenderFallbackReasoningLevel;
    } else {
      errors.push({
        field: "normalChatRecommenderFallbackReasoningLevel",
        message:
          "normalChatRecommenderFallbackReasoningLevel must be null or a non-empty provider-native value (e.g. 'low', 'medium', 'xhigh').",
      });
    }
  }

  // Long-prompt-lane fields (new)
  let longPromptThresholdTokens = DEFAULT_ROUTER_SETTINGS.longPromptThresholdTokens;
  if (b.longPromptThresholdTokens !== undefined && b.longPromptThresholdTokens !== null) {
    const raw = b.longPromptThresholdTokens;
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) {
      longPromptThresholdTokens = Math.floor(raw);
    } else {
      errors.push({
        field: "longPromptThresholdTokens",
        message: "Token threshold must be a positive number.",
      });
    }
  }

  let longPromptRecommenderModelId = DEFAULT_ROUTER_SETTINGS.longPromptRecommenderModelId;
  if (b.longPromptRecommenderModelId !== undefined) {
    if (
      typeof b.longPromptRecommenderModelId === "string" &&
      b.longPromptRecommenderModelId.trim().length > 0
    ) {
      longPromptRecommenderModelId = b.longPromptRecommenderModelId.trim();
    } else {
      errors.push({
        field: "longPromptRecommenderModelId",
        message: "longPromptRecommenderModelId must be a non-empty string.",
      });
    }
  }

  let longPromptRecommenderReasoningLevel = DEFAULT_ROUTER_SETTINGS.longPromptRecommenderReasoningLevel;
  if (b.longPromptRecommenderReasoningLevel !== undefined) {
    if (isProviderNativeReasoningValue(b.longPromptRecommenderReasoningLevel)) {
      longPromptRecommenderReasoningLevel = b.longPromptRecommenderReasoningLevel;
    } else {
      errors.push({
        field: "longPromptRecommenderReasoningLevel",
        message:
          "longPromptRecommenderReasoningLevel must be a non-empty provider-native value (e.g. 'low', 'medium', 'xhigh').",
      });
    }
  }

  let longPromptRecommenderFallbackModelId: string | null =
    DEFAULT_ROUTER_SETTINGS.longPromptRecommenderFallbackModelId;
  if (b.longPromptRecommenderFallbackModelId !== undefined) {
    if (b.longPromptRecommenderFallbackModelId === null) {
      longPromptRecommenderFallbackModelId = null;
    } else if (
      typeof b.longPromptRecommenderFallbackModelId === "string" &&
      b.longPromptRecommenderFallbackModelId.trim().length > 0
    ) {
      longPromptRecommenderFallbackModelId = b.longPromptRecommenderFallbackModelId.trim();
    } else {
      errors.push({
        field: "longPromptRecommenderFallbackModelId",
        message: "longPromptRecommenderFallbackModelId must be null or a non-empty string.",
      });
    }
  }

  let longPromptRecommenderFallbackReasoningLevel: string | null =
    DEFAULT_ROUTER_SETTINGS.longPromptRecommenderFallbackReasoningLevel;
  if (b.longPromptRecommenderFallbackReasoningLevel !== undefined) {
    if (b.longPromptRecommenderFallbackReasoningLevel === null) {
      longPromptRecommenderFallbackReasoningLevel = null;
    } else if (isProviderNativeReasoningValue(b.longPromptRecommenderFallbackReasoningLevel)) {
      longPromptRecommenderFallbackReasoningLevel = b.longPromptRecommenderFallbackReasoningLevel;
    } else {
      errors.push({
        field: "longPromptRecommenderFallbackReasoningLevel",
        message:
          "longPromptRecommenderFallbackReasoningLevel must be null or a non-empty provider-native value (e.g. 'low', 'medium', 'xhigh').",
      });
    }
  }

  let failureBehavior = DEFAULT_ROUTER_SETTINGS.failureBehavior;
  if (b.failureBehavior !== undefined) {
    if (isFailureBehavior(b.failureBehavior)) {
      failureBehavior = b.failureBehavior;
    } else {
      errors.push({
        field: "failureBehavior",
        message: "failureBehavior must be one of fail_loud, suggest_alternative, or auto_fallback.",
      });
    }
  }

  let fallbackModelId = DEFAULT_ROUTER_SETTINGS.fallbackModelId;
  if (b.fallbackModelId !== undefined) {
    if (typeof b.fallbackModelId === "string" && b.fallbackModelId.trim().length > 0) {
      fallbackModelId = b.fallbackModelId.trim();
    } else {
      errors.push({
        field: "fallbackModelId",
        message: "fallbackModelId must be a non-empty string.",
      });
    }
  }

  let fallbackReasoningLevel = DEFAULT_ROUTER_SETTINGS.fallbackReasoningLevel;
  if (b.fallbackReasoningLevel !== undefined) {
    if (isProviderNativeReasoningValue(b.fallbackReasoningLevel)) {
      fallbackReasoningLevel = b.fallbackReasoningLevel;
    } else {
      errors.push({
        field: "fallbackReasoningLevel",
        message:
          "fallbackReasoningLevel must be a non-empty provider-native value (e.g. 'low', 'medium', 'xhigh').",
      });
    }
  }

  let allowedCombos: RouterAllowedCombo[] = DEFAULT_ROUTER_SETTINGS.allowedCombos.map((c) => ({
    modelId: c.modelId,
    reasoningLevel: c.reasoningLevel,
  }));
  if (b.allowedCombos !== undefined) {
    const combosRaw = b.allowedCombos;
    if (!Array.isArray(combosRaw)) {
      errors.push({ field: "allowedCombos", message: "Allowlist must be a list." });
    } else if (combosRaw.length === 0) {
      errors.push({
        field: "allowedCombos",
        message: "Allowlist must contain at least one (model, reasoning level) combination.",
      });
    } else {
      // Validate every entry. Track duplicates so the UI can tell the
      // user "you checked the same combo twice".
      const seen = new Set<string>();
      const validRegistryEntries = new Set(
        listRouterAllowedPool(true).map((e) => `${e.modelId}|${e.reasoningLevel}`),
      );
      const registryById = registry
        ? new Map(registry.models.map((m) => [m.modelId, m] as const))
        : null;
      const next: RouterAllowedCombo[] = [];
      let hasInvalid = false;
      for (const raw of combosRaw) {
        if (!isPlainObject(raw)) {
          hasInvalid = true;
          errors.push({
            field: "allowedCombos",
            message: "Each allowlist entry must be an object.",
          });
          continue;
        }
        const modelId = typeof raw.modelId === "string" ? raw.modelId.trim() : "";
        const reasoningLevel = raw.reasoningLevel;
        if (!modelId || !isProviderNativeReasoningValue(reasoningLevel)) {
          hasInvalid = true;
          errors.push({
            field: "allowedCombos",
            message:
              "Each allowlist entry needs a model id and a provider-native reasoning level value (e.g. 'low', 'medium', 'xhigh').",
          });
          continue;
        }
        const key = `${modelId}|${reasoningLevel}`;
        if (seen.has(key)) {
          hasInvalid = true;
          errors.push({
            field: "allowedCombos",
            message: `Duplicate allowlist entry: ${modelId} / ${reasoningLevel}.`,
          });
          continue;
        }
        seen.add(key);
        if (registryById) {
          // Production path: enforce registry-aware invariants so unknown
          // models and non-OpenAI providers cannot silently enter the
          // router pool. We use the registry entry's `providerId` and
          // `configured` flag (both sourced from the local static alias
          // map at `lib/providers/openai-static.ts`) instead of the live
          // discovery snapshot — see the file-level docstring above for
          // why this matches the chat path's `resolveModel` semantics.
          //
          // Cost-safety: when the model is an OpenAI API id (no
          // provider prefix), require `allowOpenAiApiRouter` to be on.
          // Subscription providers (Codex, MiniMax) are always
          // accepted — that's the whole point of the subscription-first
          // policy. Codex/MiniMax catalog entries are not always
          // present in the live registry (they are appended in the
          // chat response, not the registry), so we fall through to
          // `providerIdFromModelId` for those.
          const entry = registryById.get(modelId);
          const providerId = entry?.providerId ?? providerIdFromModelId(modelId);
          if (!entry && providerId === "openai") {
            hasInvalid = true;
            errors.push({
              field: "allowedCombos",
              message: `Unknown model id: ${modelId}. Add it to the manual selector first.`,
            });
            continue;
          }
          if (providerId === "openai" && !allowOpenAiApiRouter) {
            hasInvalid = true;
            errors.push({
              field: "allowedCombos",
              message: `${modelId} is an OpenAI API model. OpenAI API router use is disabled — set Settings → Router → "Allow OpenAI API router use" to opt in.`,
            });
            continue;
          }
          if (entry && !entry.configured) {
            hasInvalid = true;
            errors.push({
              field: "allowedCombos",
              message: `${modelId} is not in the local model registry and cannot enter the router pool. Add it to the manual selector with explicit metadata first.`,
            });
            continue;
          }
          if (
            entry &&
            entry.supportedReasoningLevels.length > 0 &&
            !(entry.supportedReasoningLevels as ReadonlyArray<string>).includes(reasoningLevel)
          ) {
            hasInvalid = true;
            errors.push({
              field: "allowedCombos",
              message: `${modelId} does not support reasoning level ${reasoningLevel}.`,
            });
            continue;
          }
        } else if (!validRegistryEntries.has(key)) {
          // Legacy / test path: keep the original error message so the
          // existing unit tests continue to match.
          hasInvalid = true;
          errors.push({
            field: "allowedCombos",
            message: `Unknown or disallowed combination: ${modelId} / ${reasoningLevel}.`,
          });
          continue;
        }
        next.push({ modelId, reasoningLevel });
      }
      if (!hasInvalid) {
        allowedCombos = next;
      }
    }
  }

  let normalChatRecommenderAllowedModels: ReadonlyArray<string> | null =
    DEFAULT_ROUTER_SETTINGS.normalChatRecommenderAllowedModels;
  if (b.normalChatRecommenderAllowedModels !== undefined) {
    if (b.normalChatRecommenderAllowedModels === null) {
      normalChatRecommenderAllowedModels = null;
    } else if (!Array.isArray(b.normalChatRecommenderAllowedModels)) {
      errors.push({
        field: "normalChatRecommenderAllowedModels",
        message: "Recommender allowlist must be null or an array.",
      });
    } else {
      // We deliberately do NOT reject unknown ids here: the user may
      // have selected a model that was later disabled, and silently
      // filtering it out at runtime is friendlier than forcing a
      // re-save. We DO reject entries that aren't strings or are
      // blank, because those would corrupt the persisted payload.
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const raw of b.normalChatRecommenderAllowedModels) {
        if (typeof raw !== "string" || raw.trim().length === 0) {
          errors.push({
            field: "normalChatRecommenderAllowedModels",
            message: "Recommender allowlist entries must be non-empty strings.",
          });
          break;
        }
        const id = raw.trim();
        if (seen.has(id)) continue;
        seen.add(id);
        cleaned.push(id);
      }
      if (!errors.some((e) => e.field === "normalChatRecommenderAllowedModels")) {
        normalChatRecommenderAllowedModels = cleaned;
      }
    }
  }

  if (registry) {
    // Cost-safety: subscription providers (Codex, MiniMax) are always
    // accepted. OpenAI API models are gated behind
    // `allowOpenAiApiRouter` so a fresh deploy never burns paid API
    // budget. Codex/MiniMax catalog entries are not always in the
    // live registry (they are appended in the chat response, not
    // the registry), so we fall through to `providerIdFromModelId`
    // for them.
    const routerEntry = registry.models.find((m) => m.modelId === routerModelId);
    const routerProviderId = routerEntry?.providerId ?? providerIdFromModelId(routerModelId);
    if (!routerEntry && routerProviderId === "openai") {
      errors.push({
        field: "routerModelId",
        message: `Unknown router model id: ${routerModelId}.`,
      });
    } else if (routerEntry && !routerEntry.configured) {
      errors.push({
        field: "routerModelId",
        message: `${routerModelId} is not configured for this provider.`,
      });
    } else if (routerProviderId === "openai" && !allowOpenAiApiRouter) {
      errors.push({
        field: "routerModelId",
        message: `${routerModelId} is an OpenAI API model. OpenAI API router use is disabled — set Settings → Router → "Allow OpenAI API router use" to opt in.`,
      });
    }

    // Same gating for the normal-chat recommender. The recommender can
    // be any provider the registry knows about (Codex, MiniMax, or
    // OpenAI when opted in). Subscription providers are accepted by
    // default; OpenAI API is gated behind `allowOpenAiApiRouter`.
    const normalChatEntry = registry.models.find((m) => m.modelId === normalChatRecommenderModelId);
    const normalChatProviderId =
      normalChatEntry?.providerId ?? providerIdFromModelId(normalChatRecommenderModelId);
    if (!normalChatEntry && normalChatProviderId === "openai") {
      errors.push({
        field: "normalChatRecommenderModelId",
        message: `Unknown recommender model id: ${normalChatRecommenderModelId}.`,
      });
    } else if (normalChatEntry && !normalChatEntry.configured) {
      errors.push({
        field: "normalChatRecommenderModelId",
        message: `${normalChatRecommenderModelId} is not configured for this provider.`,
      });
    } else if (normalChatProviderId === "openai" && !allowOpenAiApiRouter) {
      errors.push({
        field: "normalChatRecommenderModelId",
        message: `${normalChatRecommenderModelId} is an OpenAI API model. OpenAI API router use is disabled — set Settings → Router → "Allow OpenAI API router use" to opt in.`,
      });
    }

    // Same gating for the user-configured normal-chat recommender
    // fallback. When set, it must be a configured provider the user
    // is allowed to use; the same OpenAI-API opt-in gate applies.
    // `null` (no user fallback) skips this block entirely.
    if (normalChatRecommenderFallbackModelId !== null) {
      const fallbackId = normalChatRecommenderFallbackModelId;
      const fallbackEntry = registry.models.find((m) => m.modelId === fallbackId);
      const fallbackProviderId = fallbackEntry?.providerId ?? providerIdFromModelId(fallbackId);
      if (!fallbackEntry && fallbackProviderId === "openai") {
        errors.push({
          field: "normalChatRecommenderFallbackModelId",
          message: `Unknown recommender fallback model id: ${fallbackId}.`,
        });
      } else if (fallbackEntry && !fallbackEntry.configured) {
        errors.push({
          field: "normalChatRecommenderFallbackModelId",
          message: `${fallbackId} is not configured for this provider.`,
        });
      } else if (fallbackProviderId === "openai" && !allowOpenAiApiRouter) {
        errors.push({
          field: "normalChatRecommenderFallbackModelId",
          message: `${fallbackId} is an OpenAI API model. OpenAI API router use is disabled — set Settings → Router → "Allow OpenAI API router use" to opt in.`,
        });
      }
    }
  }

  // Cross-field invariant: the fallback reasoning level must be null
  // when the fallback model is null, and must be non-empty when the
  // fallback model is set. The runtime adapter validates the value
  // against the fallback model's `reasoningCapability.options`.
  if (
    normalChatRecommenderFallbackModelId === null &&
    normalChatRecommenderFallbackReasoningLevel !== null
  ) {
    errors.push({
      field: "normalChatRecommenderFallbackReasoningLevel",
      message:
        "normalChatRecommenderFallbackReasoningLevel must be null when no fallback model is configured.",
    });
  }

  // Stage 2: legacy fallback must be in the allowlist only when automatic
  // fallback is explicitly enabled. The default fail_loud/suggest paths do
  // not silently run another combo and should not force a fallback choice.
  if (failureBehavior === "auto_fallback" && b.allowedCombos !== undefined) {
    const inAllowlist = allowedCombos.some(
      (c) => c.modelId === fallbackModelId && c.reasoningLevel === fallbackReasoningLevel,
    );
    if (!inAllowlist) {
      errors.push({
        field: "fallbackCombo",
        message: `Fallback (${fallbackModelId} / ${fallbackReasoningLevel}) must be one of the checked combinations.`,
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      abEnabled,
      allowOpenAiApiRouter,
      allowExpensiveModels,
      allowLongPromptWhenExpensive,
      longPromptThresholdChars,
      maxCostPerRecommendationUsd,
      maxCostPerAbRunUsd,
      routerModelId,
      normalChatRecommenderModelId,
      normalChatRecommenderReasoningLevel,
      failureBehavior,
      fallbackModelId,
      fallbackReasoningLevel,
      allowedCombos,
      normalChatRecommenderAllowedModels,
      normalChatRecommenderFallbackModelId,
      normalChatRecommenderFallbackReasoningLevel,
      longPromptThresholdTokens,
      longPromptRecommenderModelId,
      longPromptRecommenderReasoningLevel,
      longPromptRecommenderFallbackModelId,
      longPromptRecommenderFallbackReasoningLevel,
    },
  };
}

/**
 * Serialize a `RouterSettings` back into a JSON payload suitable for the
 * `CONTROL_ROOM_ROUTER_SETTINGS` env var or the `router_settings` JSONB
 * column.
 */
export function serializeRouterSettings(settings: RouterSettings): string {
  return JSON.stringify(settings, null, 0);
}

// ---------------------------------------------------------------------------
// Active recommender chain: configured primary + optional configured fallback.
// ---------------------------------------------------------------------------
//
// The recommender chain for normal chat and the A/B router is exactly
// two rungs: the configured primary and (if set) the configured
// fallback. If both fail the recommender returns a loud failure —
// no hidden Codex/MiniMax/OpenAI API default rung, no silent model
// substitution, no automatic API-billed run.
//
// See `buildConfiguredRecommenderChain` in
// `lib/router/recommender-config.ts` for the live chain builder.
// The dead legacy multi-rung chain (`buildRouterFallbackChain`,
// `pickRouterModelForRun`) has been removed to prevent future
// agents from accidentally re-introducing hidden fallback rungs.

let cached: RouterSettings | null = null;

/**
 * Resolve the effective `RouterSettings` for this process from the env var
 * (or the built-in defaults if it is unset/invalid). Caches the parsed
 * result for the lifetime of the process.
 *
 * NOTE: this does NOT consult the DB. The chat route uses
 * `getEffectiveRouterSettings` from `lib/router/settings-store.ts` for the
 * DB-overridable path; this function is the synchronous fallback used by
 * tests and by code paths that must not hit the DB (e.g. the Settings UI
 * itself reading the *defaults*).
 */
export function getRouterSettings(): RouterSettings {
  if (cached) return cached;
  const raw = process.env.CONTROL_ROOM_ROUTER_SETTINGS?.trim();
  if (!raw) {
    cached = DEFAULT_ROUTER_SETTINGS;
    return cached;
  }
  try {
    const parsed = parseRouterSettings(JSON.parse(raw));
    cached = parsed;
    return cached;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[router/settings] invalid CONTROL_ROOM_ROUTER_SETTINGS, using defaults:",
      err instanceof Error ? err.message : err,
    );
    cached = DEFAULT_ROUTER_SETTINGS;
    return cached;
  }
}

/**
 * Test-only: reset the in-process cache so a test can mutate the env and
 * re-read. Never call from production code.
 */
export function __resetRouterSettingsCacheForTests(): void {
  cached = null;
}
