import assert from "node:assert/strict";
import test from "node:test";

import {
  validateRouterPoolAgainstRegistry,
  validateRouterPoolLegacy,
  type RouterPoolValidationError,
} from "./registry.ts";
import type { EffectiveRegistry, EffectiveModelEntry } from "@/lib/providers/registry.ts";

function entry(overrides: Partial<EffectiveModelEntry>): EffectiveModelEntry {
  return {
    providerId: "openai",
    modelId: "gpt-5.4-mini",
    displayLabel: "GPT-5.4 Mini",
    known: true,
    available: true,
    stale: false,
    supportsReasoning: true,
    supportedReasoningLevels: ["low", "medium"],
    tier: "standard",
    usableForChat: true,
    manualSelectorVisible: true,
    routerEligible: true,
    provenance: "local_meta",
    ...overrides,
  };
}

function registry(models: ReadonlyArray<EffectiveModelEntry>): EffectiveRegistry {
  return {
    models,
    defaults: { manualModelId: null, reasoningLevel: "low" },
    discovery: {
      modelIds: models.filter((m) => m.available).map((m) => m.modelId),
      previousModelIds: [],
      fetchedAt: null,
      httpStatus: null,
      source: "fallback",
      rawCount: 0,
      errorMessage: null,
      updatedAt: null,
    },
    selectorPrefs: {},
    counts: {
      discovered: 0,
      known: 0,
      available: 0,
      stale: 0,
      manualSelectorVisible: 0,
      routerEligible: 0,
    },
    fakeMode: false,
  };
}

const KNOWN_MINI = entry({
  modelId: "gpt-5.4-mini",
  tier: "standard",
  supportedReasoningLevels: ["low", "medium"],
});
const KNOWN_BIG = entry({
  modelId: "gpt-5.5",
  displayLabel: "GPT-5.5",
  tier: "expensive",
  supportedReasoningLevels: ["low", "medium", "high"],
});
const UNKNOWN_FAKE = entry({
  modelId: "gpt-fake-unknown-xyz",
  displayLabel: "gpt-fake-unknown-xyz",
  known: false,
  available: true,
  supportsReasoning: false,
  supportedReasoningLevels: [],
  usableForChat: false,
  routerEligible: false,
  manualSelectorVisible: false,
  provenance: "fake",
});
const STALE_MINI = entry({ modelId: "gpt-5.4-mini", available: false, stale: true });

function findError(
  errors: ReadonlyArray<RouterPoolValidationError>,
  field: string,
  fragment: string,
): boolean {
  return errors.some((e) => e.field === field && e.message.includes(fragment));
}

test("validateRouterPoolAgainstRegistry rejects an empty list", () => {
  const result = validateRouterPoolAgainstRegistry({
    rawCombos: [],
    fallback: { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
    registry: registry([KNOWN_MINI]),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(findError(result.errors, "allowedCombos", "at least one"));
  }
});

test("validateRouterPoolAgainstRegistry rejects a non-array payload", () => {
  const result = validateRouterPoolAgainstRegistry({
    rawCombos: "not-an-array" as unknown as ReadonlyArray<unknown>,
    fallback: { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
    registry: registry([KNOWN_MINI]),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(findError(result.errors, "allowedCombos", "must be a list"));
  }
});

test("validateRouterPoolAgainstRegistry rejects an unknown model id", () => {
  const result = validateRouterPoolAgainstRegistry({
    rawCombos: [{ modelId: "gpt-not-a-real-model", reasoningLevel: "low" }],
    fallback: { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
    registry: registry([KNOWN_MINI]),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(findError(result.errors, "allowedCombos", "Unknown model id"));
  }
});

test("validateRouterPoolAgainstRegistry rejects an unknown (discovered-only) model with a clear message", () => {
  const result = validateRouterPoolAgainstRegistry({
    rawCombos: [{ modelId: "gpt-fake-unknown-xyz", reasoningLevel: "low" }],
    fallback: { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
    registry: registry([KNOWN_MINI, UNKNOWN_FAKE]),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      findError(result.errors, "allowedCombos", "not in the local model registry") ||
        findError(result.errors, "allowedCombos", "Unknown model id"),
      "expected the unknown-model rejection",
    );
  }
});

test("validateRouterPoolAgainstRegistry rejects a known model that is not available in the current discovery", () => {
  const result = validateRouterPoolAgainstRegistry({
    rawCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
    fallback: { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
    registry: registry([entry({ modelId: "gpt-5.4-mini", available: false })]),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(findError(result.errors, "allowedCombos", "not currently available"));
  }
});

test("validateRouterPoolAgainstRegistry rejects a stale model id", () => {
  const result = validateRouterPoolAgainstRegistry({
    rawCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
    fallback: { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
    registry: registry([STALE_MINI]),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(findError(result.errors, "allowedCombos", "not currently available"));
  }
});

test("validateRouterPoolAgainstRegistry rejects a reasoning level not supported by the model", () => {
  const result = validateRouterPoolAgainstRegistry({
    rawCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "high" }],
    fallback: { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
    registry: registry([KNOWN_MINI]),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(findError(result.errors, "allowedCombos", "does not support reasoning level high"));
  }
});

test("validateRouterPoolAgainstRegistry rejects a fallback not in the validated entries", () => {
  const result = validateRouterPoolAgainstRegistry({
    rawCombos: [
      { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
      { modelId: "gpt-5.4-mini", reasoningLevel: "medium" },
    ],
    fallback: { modelId: "gpt-5.5", reasoningLevel: "low" },
    registry: registry([KNOWN_MINI, KNOWN_BIG]),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(findError(result.errors, "fallbackCombo", "must be one of the checked combinations"));
  }
});

test("validateRouterPoolAgainstRegistry rejects a duplicate entry", () => {
  const result = validateRouterPoolAgainstRegistry({
    rawCombos: [
      { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
      { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
    ],
    fallback: { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
    registry: registry([KNOWN_MINI]),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(findError(result.errors, "allowedCombos", "Duplicate allowlist entry"));
  }
});

test("validateRouterPoolAgainstRegistry accepts a valid known+available+supported combo", () => {
  const result = validateRouterPoolAgainstRegistry({
    rawCombos: [
      { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
      { modelId: "gpt-5.5", reasoningLevel: "high" },
    ],
    fallback: { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
    registry: registry([KNOWN_MINI, KNOWN_BIG]),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.combos.length, 2);
    assert.deepEqual(result.combos[0], { modelId: "gpt-5.4-mini", reasoningLevel: "low" });
    assert.deepEqual(result.combos[1], { modelId: "gpt-5.5", reasoningLevel: "high" });
  }
});

test("validateRouterPoolAgainstRegistry accumulates all errors before returning", () => {
  const result = validateRouterPoolAgainstRegistry({
    rawCombos: [
      { modelId: "gpt-not-real", reasoningLevel: "low" },
      { modelId: "gpt-5.4-mini", reasoningLevel: "high" },
    ],
    fallback: { modelId: "gpt-5.5", reasoningLevel: "low" },
    registry: registry([KNOWN_MINI, KNOWN_BIG]),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    // Expect at least 3 errors:
    //   1. gpt-not-real is unknown
    //   2. gpt-5.4-mini does not support high reasoning
    //   3. fallback (gpt-5.5/low) is not in the validated entries (which
    //      is empty because both combos were rejected)
    assert.ok(
      result.errors.length >= 3,
      `should accumulate all field errors, got ${result.errors.length}`,
    );
    assert.ok(findError(result.errors, "allowedCombos", "Unknown model id"));
    assert.ok(findError(result.errors, "allowedCombos", "does not support reasoning level high"));
    assert.ok(findError(result.errors, "fallbackCombo", "must be one of the checked combinations"));
  }
});

test("validateRouterPoolLegacy rejects an empty list", () => {
  const result = validateRouterPoolLegacy({
    rawCombos: [],
    fallback: { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
  });
  assert.equal(result.ok, false);
});

test("validateRouterPoolLegacy accepts a combo from the static pool", () => {
  const result = validateRouterPoolLegacy({
    rawCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
    fallback: { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
  });
  assert.equal(result.ok, true);
});

test("validateRouterPoolLegacy rejects a model that is not in the static alias map", () => {
  const result = validateRouterPoolLegacy({
    rawCombos: [{ modelId: "gpt-not-a-real-model", reasoningLevel: "low" }],
    fallback: { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(findError(result.errors, "allowedCombos", "Unknown or disallowed combination"));
  }
});
