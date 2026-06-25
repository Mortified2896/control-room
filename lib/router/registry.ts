import type { EffectiveRegistry } from "@/lib/providers/registry";
import type { ReasoningLevel } from "@/lib/providers/types";
import { listRouterAllowedPool } from "@/lib/providers";

/**
 * Strict router-pool validator against the live registry.
 *
 * Mirrors the per-field shape of `parseRouterSettingsForSave` (see
 * `lib/router/schema.ts`) but its authority comes from the merged
 * `EffectiveRegistry` instead of the static `OPENAI_MODEL_METAS` table.
 *
 * Invariants enforced (errors accumulated, never short-circuited):
 *   1. `rawCombos` is a non-empty array of objects.
 *   2. Every entry has a non-empty model id and a recognized reasoning
 *      level.
 *   3. No duplicate (modelId, reasoningLevel) pairs.
 *   4. The model id must be in the registry (it must exist somewhere —
 *      known or discovered).
 *   5. The model must be `known=true`. Unknown discovered models cannot
 *      enter the router pool under any UI path (brief, hard rule).
 *   6. The model must be `available=true` and not stale.
 *   7. The reasoning level must be in the model's
 *      `supportedReasoningLevels`.
 *   8. The fallback combo must be one of the validated entries. We
 *      always check (even when `validated` is empty) so the user gets a
 *      clear "fallback not in pool" error even when every combo was
 *      rejected for other reasons.
 *
 * When no registry is provided, `validateRouterPoolLegacy` is the
 * fallback so existing tests that don't construct an `EffectiveRegistry`
 * keep working.
 */

export type RouterCombo = { modelId: string; reasoningLevel: ReasoningLevel };

export type RouterPoolValidationError = {
  field: string;
  message: string;
};

export type RouterPoolValidationResult =
  | { ok: true; combos: ReadonlyArray<RouterCombo> }
  | { ok: false; errors: ReadonlyArray<RouterPoolValidationError> };

const REASONING_LEVELS: ReadonlyArray<ReasoningLevel> = ["low", "medium", "high"];

function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && (REASONING_LEVELS as ReadonlyArray<string>).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateRouterPoolAgainstRegistry(input: {
  rawCombos: ReadonlyArray<unknown>;
  fallback: { modelId: string; reasoningLevel: ReasoningLevel };
  registry: EffectiveRegistry;
}): RouterPoolValidationResult {
  const errors: RouterPoolValidationError[] = [];
  const { rawCombos, fallback, registry } = input;

  if (!Array.isArray(rawCombos)) {
    return {
      ok: false,
      errors: [{ field: "allowedCombos", message: "Allowlist must be a list." }],
    };
  }
  if (rawCombos.length === 0) {
    return {
      ok: false,
      errors: [
        {
          field: "allowedCombos",
          message: "Allowlist must contain at least one (model, reasoning level) combination.",
        },
      ],
    };
  }

  const registryById = new Map(registry.models.map((m) => [m.modelId, m] as const));
  const seen = new Set<string>();
  const validated: RouterCombo[] = [];

  for (const raw of rawCombos) {
    if (!isPlainObject(raw)) {
      errors.push({
        field: "allowedCombos",
        message: "Each allowlist entry must be an object.",
      });
      continue;
    }
    const modelId = typeof raw.modelId === "string" ? raw.modelId.trim() : "";
    const reasoningLevel = raw.reasoningLevel;
    if (!modelId || !isReasoningLevel(reasoningLevel)) {
      errors.push({
        field: "allowedCombos",
        message: "Each allowlist entry needs a model id and a reasoning level.",
      });
      continue;
    }
    const key = `${modelId}|${reasoningLevel}`;
    if (seen.has(key)) {
      errors.push({
        field: "allowedCombos",
        message: `Duplicate allowlist entry: ${modelId} / ${reasoningLevel}.`,
      });
      continue;
    }
    seen.add(key);

    const entry = registryById.get(modelId);
    if (!entry) {
      errors.push({
        field: "allowedCombos",
        message: `Unknown model id: ${modelId}. Add it to the manual selector first.`,
      });
      continue;
    }
    if (!entry.known) {
      errors.push({
        field: "allowedCombos",
        message: `${modelId} is not in the local model registry and cannot enter the router pool. Add it to the manual selector with explicit metadata first.`,
      });
      continue;
    }
    if (!entry.available || entry.stale) {
      errors.push({
        field: "allowedCombos",
        message: `${modelId} is not currently available from OpenAI. Refresh the model catalog or remove it from the allowlist.`,
      });
      continue;
    }
    if (!(entry.supportedReasoningLevels as ReadonlyArray<string>).includes(reasoningLevel)) {
      errors.push({
        field: "allowedCombos",
        message: `${modelId} does not support reasoning level ${reasoningLevel}.`,
      });
      continue;
    }
    validated.push({ modelId, reasoningLevel });
  }

  // Fallback must be in the validated allowlist. We always check (even
  // when `validated` is empty) so the user gets a clear "fallback not
  // in pool" error even if every combo was rejected for other reasons.
  const inAllowlist = validated.some(
    (c) => c.modelId === fallback.modelId && c.reasoningLevel === fallback.reasoningLevel,
  );
  if (!inAllowlist) {
    errors.push({
      field: "fallbackCombo",
      message: `Fallback (${fallback.modelId} / ${fallback.reasoningLevel}) must be one of the checked combinations.`,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, combos: validated };
}

// ---------------------------------------------------------------------------
// Backward-compat overload (no registry).
// ---------------------------------------------------------------------------
//
// Preserves the original `parseRouterSettingsForSave` behavior for tests +
// the env-only path that never sees the DB-backed registry. Returns the
// same error messages the existing `lib/router/schema.ts` test suite
// asserts against.

export function validateRouterPoolLegacy(input: {
  rawCombos: ReadonlyArray<unknown>;
  fallback: { modelId: string; reasoningLevel: ReasoningLevel };
}): RouterPoolValidationResult {
  const errors: RouterPoolValidationError[] = [];
  const { rawCombos, fallback } = input;

  if (!Array.isArray(rawCombos)) {
    return {
      ok: false,
      errors: [{ field: "allowedCombos", message: "Allowlist must be a list." }],
    };
  }
  if (rawCombos.length === 0) {
    return {
      ok: false,
      errors: [
        {
          field: "allowedCombos",
          message: "Allowlist must contain at least one (model, reasoning level) combination.",
        },
      ],
    };
  }

  const validRegistryEntries = new Set(
    listRouterAllowedPool(true).map((e) => `${e.modelId}|${e.reasoningLevel}`),
  );
  const seen = new Set<string>();
  const validated: RouterCombo[] = [];

  for (const raw of rawCombos) {
    if (!isPlainObject(raw)) {
      errors.push({
        field: "allowedCombos",
        message: "Each allowlist entry must be an object.",
      });
      continue;
    }
    const modelId = typeof raw.modelId === "string" ? raw.modelId.trim() : "";
    const reasoningLevel = raw.reasoningLevel;
    if (!modelId || !isReasoningLevel(reasoningLevel)) {
      errors.push({
        field: "allowedCombos",
        message: "Each allowlist entry needs a model id and a reasoning level.",
      });
      continue;
    }
    const key = `${modelId}|${reasoningLevel}`;
    if (seen.has(key)) {
      errors.push({
        field: "allowedCombos",
        message: `Duplicate allowlist entry: ${modelId} / ${reasoningLevel}.`,
      });
      continue;
    }
    seen.add(key);
    if (!validRegistryEntries.has(key)) {
      errors.push({
        field: "allowedCombos",
        message: `Unknown or disallowed combination: ${modelId} / ${reasoningLevel}.`,
      });
      continue;
    }
    validated.push({ modelId, reasoningLevel });
  }

  // Always check the fallback (matches the registry-aware validator).
  const inAllowlist = validated.some(
    (c) => c.modelId === fallback.modelId && c.reasoningLevel === fallback.reasoningLevel,
  );
  if (!inAllowlist) {
    errors.push({
      field: "fallbackCombo",
      message: `Fallback (${fallback.modelId} / ${fallback.reasoningLevel}) must be one of the checked combinations.`,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, combos: validated };
}
