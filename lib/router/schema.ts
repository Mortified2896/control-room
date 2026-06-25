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
 */
import { DEFAULT_REASONING_LEVEL } from "@/lib/providers/openai";
import type { ReasoningLevel } from "@/lib/providers/types";
import { listRouterAllowedPool } from "@/lib/providers";

export type RouterAllowedCombo = {
  modelId: string;
  reasoningLevel: ReasoningLevel;
};

export type RouterSettings = {
  /** Master kill-switch. When false, the router never runs and Side B is skipped. */
  abEnabled: boolean;
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
  /** Model id used when the router fails or returns a disallowed value. */
  fallbackModelId: string;
  /** Reasoning level used when the router fails or returns a disallowed value. */
  fallbackReasoningLevel: ReasoningLevel;
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
};

/**
 * Default authorized combos for the MVP: every cheap-tier pairing the
 * registry exposes, i.e. (gpt-5.4-mini, low) + (gpt-5.4-mini, medium).
 *
 * This intentionally does NOT include any expensive-tier combo — those
 * require the user to opt in via `allowExpensiveModels`.
 */
const DEFAULT_ALLOWED_COMBOS: ReadonlyArray<RouterAllowedCombo> = [
  { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
  { modelId: "gpt-5.4-mini", reasoningLevel: "medium" },
];

export const DEFAULT_ROUTER_SETTINGS: RouterSettings = {
  abEnabled: true,
  allowExpensiveModels: false,
  allowLongPromptWhenExpensive: false,
  longPromptThresholdChars: 1500,
  maxCostPerRecommendationUsd: 0.03,
  maxCostPerAbRunUsd: 0.3,
  routerModelId: "gpt-5.4-mini",
  fallbackModelId: "gpt-5.4-mini",
  fallbackReasoningLevel: DEFAULT_REASONING_LEVEL,
  allowedCombos: DEFAULT_ALLOWED_COMBOS,
};

const REASONING_LEVELS: ReadonlyArray<ReasoningLevel> = ["low", "medium", "high"];

function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && (REASONING_LEVELS as ReadonlyArray<string>).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (input.fallbackModelId !== undefined) {
    if (typeof input.fallbackModelId !== "string" || input.fallbackModelId.trim().length === 0) {
      throw new Error("fallbackModelId must be a non-empty string");
    }
    out.fallbackModelId = input.fallbackModelId.trim();
  }
  if (input.fallbackReasoningLevel !== undefined) {
    if (!isReasoningLevel(input.fallbackReasoningLevel)) {
      throw new Error("fallbackReasoningLevel must be one of 'low' | 'medium' | 'high'");
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
      if (!isReasoningLevel(reasoningLevel)) {
        throw new Error("allowedCombos[].reasoningLevel must be one of 'low' | 'medium' | 'high'");
      }
      combos.push({ modelId: modelId.trim(), reasoningLevel });
    }
    out.allowedCombos = combos;
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
 *   - the model is currently available (not stale),
 *   - the reasoning level is in the model's supported set.
 *
 * When no registry is supplied (the env-only / test path), the legacy
 * `listRouterAllowedPool(true)` set is used. This preserves the existing
 * `lib/router/settings.test.ts` assertions.
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
    if (isReasoningLevel(b.fallbackReasoningLevel)) {
      fallbackReasoningLevel = b.fallbackReasoningLevel;
    } else {
      errors.push({
        field: "fallbackReasoningLevel",
        message: "fallbackReasoningLevel must be one of 'low' | 'medium' | 'high'.",
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
        if (!modelId || !isReasoningLevel(reasoningLevel)) {
          hasInvalid = true;
          errors.push({
            field: "allowedCombos",
            message: "Each allowlist entry needs a model id and a reasoning level.",
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
          // discovered models cannot silently enter the router pool.
          const entry = registryById.get(modelId);
          if (!entry) {
            hasInvalid = true;
            errors.push({
              field: "allowedCombos",
              message: `Unknown model id: ${modelId}. Add it to the manual selector first.`,
            });
            continue;
          }
          if (!entry.known) {
            hasInvalid = true;
            errors.push({
              field: "allowedCombos",
              message: `${modelId} is not in the local model registry and cannot enter the router pool. Add it to the manual selector with explicit metadata first.`,
            });
            continue;
          }
          if (!entry.available || entry.stale) {
            hasInvalid = true;
            errors.push({
              field: "allowedCombos",
              message: `${modelId} is not currently available from OpenAI. Refresh the model catalog or remove it from the allowlist.`,
            });
            continue;
          }
          if (!(entry.supportedReasoningLevels as ReadonlyArray<string>).includes(reasoningLevel)) {
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

  // Stage 2: fallback must be in the allowlist. We always check (even
  // when the allowlist was rejected as invalid) so the user gets a
  // clear "fallback not in pool" error when every combo was rejected
  // for other reasons.
  if (b.allowedCombos !== undefined) {
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
      allowExpensiveModels,
      allowLongPromptWhenExpensive,
      longPromptThresholdChars,
      maxCostPerRecommendationUsd,
      maxCostPerAbRunUsd,
      routerModelId,
      fallbackModelId,
      fallbackReasoningLevel,
      allowedCombos,
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
