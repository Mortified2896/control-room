import assert from "node:assert/strict";
import test from "node:test";

import type { EffectiveRegistry } from "@/lib/providers/registry";

import {
  __resetRouterSettingsCacheForTests,
  DEFAULT_ROUTER_SETTINGS,
  getRouterSettings,
  parseRouterSettings,
  parseRouterSettingsForSave,
  serializeRouterSettings,
} from "./schema.ts";

test("parseRouterSettings accepts an empty payload and returns defaults", () => {
  assert.deepEqual(parseRouterSettings({}), DEFAULT_ROUTER_SETTINGS);
});

test("parseRouterSettings rejects non-object payloads", () => {
  assert.throws(() => parseRouterSettings(null), /must be a JSON object/);
  assert.throws(() => parseRouterSettings(undefined), /must be a JSON object/);
  assert.throws(() => parseRouterSettings("string"), /must be a JSON object/);
  assert.throws(() => parseRouterSettings(42), /must be a JSON object/);
});

test("parseRouterSettings rejects out-of-range numeric fields", () => {
  assert.throws(() => parseRouterSettings({ maxCostPerAbRunUsd: -1 }), /non-negative/);
  assert.throws(() => parseRouterSettings({ longPromptThresholdChars: -10 }), /non-negative/);
  assert.throws(() => parseRouterSettings({ maxCostPerRecommendationUsd: NaN }), /finite/);
});

test("parseRouterSettings rejects unknown reasoning levels", () => {
  assert.throws(
    () => parseRouterSettings({ fallbackReasoningLevel: "ultra" }),
    /low.*medium.*high/,
  );
});

test("parseRouterSettings accepts allowedCombos overrides", () => {
  const parsed = parseRouterSettings({
    allowedCombos: [
      { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
      { modelId: "gpt-5.4-mini", reasoningLevel: "medium" },
    ],
  });
  assert.equal(parsed.allowedCombos.length, 2);
  assert.equal(parsed.allowedCombos[0]?.modelId, "gpt-5.4-mini");
});

test("parseRouterSettings rejects malformed allowedCombos entries", () => {
  assert.throws(
    () =>
      parseRouterSettings({
        allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "ultra" }],
      }),
    /reasoningLevel/,
  );
  assert.throws(
    () =>
      parseRouterSettings({
        allowedCombos: "not-an-array",
      }),
    /must be an array/,
  );
});

test("serializeRouterSettings round-trips through parseRouterSettings", () => {
  const overrides = {
    allowExpensiveModels: true,
    maxCostPerAbRunUsd: 0.42,
    fallbackModelId: "gpt-5.5",
    fallbackReasoningLevel: "medium" as const,
    allowedCombos: [
      { modelId: "gpt-5.4-mini", reasoningLevel: "low" as const },
      { modelId: "gpt-5.4-mini", reasoningLevel: "medium" as const },
    ],
  };
  const serialized = serializeRouterSettings({ ...DEFAULT_ROUTER_SETTINGS, ...overrides });
  const parsed = parseRouterSettings(JSON.parse(serialized));
  assert.equal(parsed.allowExpensiveModels, true);
  assert.equal(parsed.maxCostPerAbRunUsd, 0.42);
  assert.equal(parsed.fallbackModelId, "gpt-5.5");
  assert.equal(parsed.fallbackReasoningLevel, "medium");
  // Unspecified fields keep their default.
  assert.equal(parsed.routerModelId, DEFAULT_ROUTER_SETTINGS.routerModelId);
  assert.equal(parsed.allowedCombos.length, 2);
});

test("parseRouterSettingsForSave rejects an empty allowlist", () => {
  const result = parseRouterSettingsForSave({
    allowedCombos: [],
    fallbackModelId: "gpt-5.4-mini",
    fallbackReasoningLevel: "low",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.errors.some((e) => e.field === "allowedCombos"),
      "expected an allowedCombos error",
    );
  }
});

test("parseRouterSettingsForSave rejects a negative threshold", () => {
  const result = parseRouterSettingsForSave({
    longPromptThresholdChars: -1,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.errors.some((e) => e.field === "longPromptThresholdChars"),
      "expected a threshold error",
    );
  }
});

test("parseRouterSettingsForSave accepts a null threshold (use default)", () => {
  const result = parseRouterSettingsForSave({
    longPromptThresholdChars: null,
    allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
    fallbackModelId: "gpt-5.4-mini",
    fallbackReasoningLevel: "low",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(
      result.value.longPromptThresholdChars,
      DEFAULT_ROUTER_SETTINGS.longPromptThresholdChars,
    );
  }
});

test("parseRouterSettingsForSave rejects a fallback not in the allowlist when auto_fallback is enabled", () => {
  const result = parseRouterSettingsForSave({
    allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
    failureBehavior: "auto_fallback",
    fallbackModelId: "gpt-5.4-mini",
    fallbackReasoningLevel: "medium", // medium is allowed by the model but unchecked
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.errors.some((e) => e.field === "fallbackCombo"),
      "expected a fallbackCombo error",
    );
  }
});

test("parseRouterSettingsForSave rejects a duplicate allowlist entry", () => {
  const result = parseRouterSettingsForSave({
    allowedCombos: [
      { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
      { modelId: "gpt-5.4-mini", reasoningLevel: "low" },
    ],
    fallbackModelId: "gpt-5.4-mini",
    fallbackReasoningLevel: "low",
  });
  assert.equal(result.ok, false);
});

test("parseRouterSettingsForSave rejects an unknown model id in the allowlist", () => {
  const result = parseRouterSettingsForSave({
    allowedCombos: [{ modelId: "gpt-not-a-real-model", reasoningLevel: "low" }],
    fallbackModelId: "gpt-5.4-mini",
    fallbackReasoningLevel: "low",
  });
  assert.equal(result.ok, false);
});

test("parseRouterSettingsForSave with registry: rejects an unknown model id with the new helpful message", () => {
  const result = parseRouterSettingsForSave(
    {
      allowedCombos: [{ modelId: "gpt-not-a-real-model", reasoningLevel: "low" }],
      fallbackModelId: "gpt-5.4-mini",
      fallbackReasoningLevel: "low",
    },
    {
      models: [
        {
          providerId: "openai",
          modelId: "gpt-5.4-mini",
          displayLabel: "GPT-5.4 Mini",
          configured: true,
          available: true,
          stale: false,
          supportsReasoning: true,
          supportedReasoningLevels: ["low", "medium"],
          tier: "standard",
          usableForChat: true,
          manualSelectorVisible: true,
          manuallyOverridden: false,
          routerEligible: true,
          capabilities: {
            reasoning: true,
            vision: false,
            images: false,
            functionCalling: false,
            structuredOutput: false,
            streaming: true,
          },
          provenance: "local_meta",
        },
      ],
      defaults: { manualModelId: "gpt-5.4-mini", reasoningLevel: "low" },
      discovery: {
        modelIds: ["gpt-5.4-mini"],
        previousModelIds: [],
        fetchedAt: new Date(),
        httpStatus: 200,
        source: "openai",
        rawCount: 1,
        errorMessage: null,
        updatedAt: new Date(),
      },
      selectorPrefs: {},
      counts: {
        discovered: 1,
        discoveredConfigured: 1,
        discoveredUnclassified: 0,
        configuredAvailable: 1,
        stale: 0,
        manualSelectorVisible: 1,
        routerEligible: 1,
      },
      fakeMode: false,
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.errors.some((e) => e.field === "allowedCombos" && /Unknown model id/.test(e.message)),
      "expected registry-aware unknown-model error",
    );
  }
});

test("parseRouterSettingsForSave with registry: accepts a configured OpenAI model that is not currently in the discovery snapshot", () => {
  // Mirrors the production scenario: `gpt-5.4-mini` is in the local
  // static alias map (configured=true) but OpenAI's live discovery
  // snapshot does not currently return it (e.g. the key lacks access
  // or the snapshot is stale). `/api/model/recommend` and `/api/chat`
  // both still use this model via `resolveModel`, so the router
  // settings validator must not reject it. Only `configured` and the
  // OpenAI provider are required when a registry is supplied.
  const result = parseRouterSettingsForSave(
    {
      allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
      fallbackModelId: "gpt-5.4-mini",
      fallbackReasoningLevel: "low",
    },
    {
      models: [
        {
          providerId: "openai",
          modelId: "gpt-5.4-mini",
          displayLabel: "GPT-5.4 Mini",
          configured: true,
          available: false,
          stale: true,
          supportsReasoning: true,
          supportedReasoningLevels: ["low", "medium"],
          tier: "standard",
          usableForChat: false,
          manualSelectorVisible: false,
          manuallyOverridden: false,
          routerEligible: false,
          capabilities: {
            reasoning: true,
            vision: false,
            images: false,
            functionCalling: false,
            structuredOutput: false,
            streaming: true,
          },
          provenance: "stale",
        },
      ],
      defaults: { manualModelId: null, reasoningLevel: "low" },
      discovery: {
        modelIds: [],
        previousModelIds: ["gpt-5.4-mini"],
        fetchedAt: new Date(),
        httpStatus: 200,
        source: "openai",
        rawCount: 1,
        errorMessage: null,
        updatedAt: new Date(),
      },
      selectorPrefs: {},
      counts: {
        discovered: 0,
        discoveredConfigured: 0,
        discoveredUnclassified: 0,
        configuredAvailable: 0,
        stale: 1,
        manualSelectorVisible: 0,
        routerEligible: 0,
      },
      fakeMode: false,
    },
  );
  assert.equal(result.ok, true);
});

test("parseRouterSettingsForSave with registry: rejects a Codex (codex:) model id", () => {
  // The router pool is OpenAI-only by design. Codex models belong to
  // the `codex` provider, not `openai`, and must not leak into the
  // normal-chat router allowlist even when the model id is a known
  // Codex catalog entry.
  // The cast widens the test fixtures' providerId beyond the strict
  // "openai" literal in EffectiveRegistry — this matches what
  // `serializeRegistryModels` already does in the production route.
  const result = parseRouterSettingsForSave(
    {
      allowedCombos: [{ modelId: "codex:gpt-5.5", reasoningLevel: "low" }],
      fallbackModelId: "gpt-5.4-mini",
      fallbackReasoningLevel: "low",
    },
    {
      models: [
        {
          providerId: "openai",
          modelId: "gpt-5.4-mini",
          displayLabel: "GPT-5.4 Mini",
          configured: true,
          available: true,
          stale: false,
          supportsReasoning: true,
          supportedReasoningLevels: ["low", "medium"],
          tier: "standard",
          usableForChat: true,
          manualSelectorVisible: true,
          manuallyOverridden: false,
          routerEligible: true,
          capabilities: {
            reasoning: true,
            vision: false,
            images: false,
            functionCalling: false,
            structuredOutput: false,
            streaming: true,
          },
          provenance: "local_meta",
        },
        {
          providerId: "codex",
          modelId: "codex:gpt-5.5",
          displayLabel: "Codex · GPT-5.5",
          configured: true,
          available: true,
          stale: false,
          supportsReasoning: false,
          supportedReasoningLevels: [],
          tier: "expensive",
          usableForChat: true,
          manualSelectorVisible: true,
          manuallyOverridden: false,
          routerEligible: false,
          capabilities: {
            reasoning: false,
            vision: false,
            images: false,
            functionCalling: false,
            structuredOutput: false,
            streaming: true,
          },
          provenance: "env_static",
        },
      ],
      defaults: { manualModelId: "gpt-5.4-mini", reasoningLevel: "low" },
      discovery: {
        modelIds: ["gpt-5.4-mini"],
        previousModelIds: [],
        fetchedAt: new Date(),
        httpStatus: 200,
        source: "openai",
        rawCount: 1,
        errorMessage: null,
        updatedAt: new Date(),
      },
      selectorPrefs: {},
      counts: {
        discovered: 1,
        discoveredConfigured: 1,
        discoveredUnclassified: 0,
        configuredAvailable: 1,
        stale: 0,
        manualSelectorVisible: 2,
        routerEligible: 1,
      },
      fakeMode: false,
    } as unknown as EffectiveRegistry,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.errors.some(
        (e) =>
          e.field === "allowedCombos" &&
          /belongs to codex.*OpenAI-only/.test(e.message),
      ),
      `expected an OpenAI-only rejection for codex id, got: ${JSON.stringify(result.errors)}`,
    );
  }
});

test("parseRouterSettingsForSave with registry: rejects a MiniMax model id", () => {
  const result = parseRouterSettingsForSave(
    {
      allowedCombos: [{ modelId: "MiniMax-M3", reasoningLevel: "low" }],
      fallbackModelId: "gpt-5.4-mini",
      fallbackReasoningLevel: "low",
    },
    {
      models: [
        {
          providerId: "openai",
          modelId: "gpt-5.4-mini",
          displayLabel: "GPT-5.4 Mini",
          configured: true,
          available: true,
          stale: false,
          supportsReasoning: true,
          supportedReasoningLevels: ["low", "medium"],
          tier: "standard",
          usableForChat: true,
          manualSelectorVisible: true,
          manuallyOverridden: false,
          routerEligible: true,
          capabilities: {
            reasoning: true,
            vision: false,
            images: false,
            functionCalling: false,
            structuredOutput: false,
            streaming: true,
          },
          provenance: "local_meta",
        },
        {
          providerId: "minimax",
          modelId: "MiniMax-M3",
          displayLabel: "MiniMax-M3",
          configured: true,
          available: true,
          stale: false,
          supportsReasoning: false,
          supportedReasoningLevels: [],
          tier: "standard",
          usableForChat: true,
          manualSelectorVisible: true,
          manuallyOverridden: false,
          routerEligible: false,
          capabilities: {
            reasoning: false,
            vision: false,
            images: false,
            functionCalling: false,
            structuredOutput: false,
            streaming: true,
          },
          provenance: "env_static",
        },
      ],
      defaults: { manualModelId: "gpt-5.4-mini", reasoningLevel: "low" },
      discovery: {
        modelIds: ["gpt-5.4-mini"],
        previousModelIds: [],
        fetchedAt: new Date(),
        httpStatus: 200,
        source: "openai",
        rawCount: 1,
        errorMessage: null,
        updatedAt: new Date(),
      },
      selectorPrefs: {},
      counts: {
        discovered: 1,
        discoveredConfigured: 1,
        discoveredUnclassified: 0,
        configuredAvailable: 1,
        stale: 0,
        manualSelectorVisible: 2,
        routerEligible: 1,
      },
      fakeMode: false,
    } as unknown as EffectiveRegistry,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.errors.some(
        (e) =>
          e.field === "allowedCombos" &&
          /belongs to minimax.*OpenAI-only/.test(e.message),
      ),
      `expected an OpenAI-only rejection for MiniMax id, got: ${JSON.stringify(result.errors)}`,
    );
  }
});

test("parseRouterSettingsForSave with registry: rejects an unconfigured (not in static map) model", () => {
  const result = parseRouterSettingsForSave(
    {
      allowedCombos: [{ modelId: "gpt-fake-unknown-xyz", reasoningLevel: "low" }],
      fallbackModelId: "gpt-5.4-mini",
      fallbackReasoningLevel: "low",
    },
    {
      models: [
        {
          providerId: "openai",
          modelId: "gpt-5.4-mini",
          displayLabel: "GPT-5.4 Mini",
          configured: true,
          available: true,
          stale: false,
          supportsReasoning: true,
          supportedReasoningLevels: ["low", "medium"],
          tier: "standard",
          usableForChat: true,
          manualSelectorVisible: true,
          manuallyOverridden: false,
          routerEligible: true,
          capabilities: {
            reasoning: true,
            vision: false,
            images: false,
            functionCalling: false,
            structuredOutput: false,
            streaming: true,
          },
          provenance: "local_meta",
        },
        {
          providerId: "openai",
          modelId: "gpt-fake-unknown-xyz",
          displayLabel: "gpt-fake-unknown-xyz",
          configured: false,
          available: true,
          stale: false,
          supportsReasoning: false,
          supportedReasoningLevels: [],
          tier: "unknown",
          usableForChat: false,
          manualSelectorVisible: false,
          manuallyOverridden: false,
          routerEligible: false,
          capabilities: {
            reasoning: false,
            vision: false,
            images: false,
            functionCalling: false,
            structuredOutput: false,
            streaming: true,
          },
          provenance: "fake",
        },
      ],
      defaults: { manualModelId: "gpt-5.4-mini", reasoningLevel: "low" },
      discovery: {
        modelIds: ["gpt-5.4-mini", "gpt-fake-unknown-xyz"],
        previousModelIds: [],
        fetchedAt: new Date(),
        httpStatus: 200,
        source: "fake",
        rawCount: 2,
        errorMessage: null,
        updatedAt: new Date(),
      },
      selectorPrefs: {},
      counts: {
        discovered: 2,
        discoveredConfigured: 1,
        discoveredUnclassified: 1,
        configuredAvailable: 1,
        stale: 0,
        manualSelectorVisible: 1,
        routerEligible: 1,
      },
      fakeMode: true,
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.errors.some(
        (e) =>
          e.field === "allowedCombos" &&
          /not in the local model registry|cannot enter the router pool/.test(e.message),
      ),
    );
  }
});

test("parseRouterSettingsForSave without registry: still uses the legacy error message", () => {
  const result = parseRouterSettingsForSave({
    allowedCombos: [{ modelId: "gpt-not-a-real-model", reasoningLevel: "low" }],
    fallbackModelId: "gpt-5.4-mini",
    fallbackReasoningLevel: "low",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    // Legacy path emits the original "Unknown or disallowed combination" message.
    assert.ok(
      result.errors.some(
        (e) => e.field === "allowedCombos" && /Unknown or disallowed combination/.test(e.message),
      ),
    );
  }
});

test("parseRouterSettingsForSave accepts the defaults", () => {
  const result = parseRouterSettingsForSave(DEFAULT_ROUTER_SETTINGS);
  assert.equal(result.ok, true);
});

test("getRouterSettings returns defaults when CONTROL_ROOM_ROUTER_SETTINGS is unset", () => {
  delete process.env.CONTROL_ROOM_ROUTER_SETTINGS;
  __resetRouterSettingsCacheForTests();
  const s = getRouterSettings();
  assert.deepEqual(s, DEFAULT_ROUTER_SETTINGS);
});

test("getRouterSettings applies a valid env-var payload", () => {
  process.env.CONTROL_ROOM_ROUTER_SETTINGS = JSON.stringify({
    allowExpensiveModels: true,
    maxCostPerAbRunUsd: 0.99,
  });
  __resetRouterSettingsCacheForTests();
  const s = getRouterSettings();
  assert.equal(s.allowExpensiveModels, true);
  assert.equal(s.maxCostPerAbRunUsd, 0.99);
  delete process.env.CONTROL_ROOM_ROUTER_SETTINGS;
  __resetRouterSettingsCacheForTests();
});

test("getRouterSettings falls back to defaults on an invalid env-var payload", () => {
  process.env.CONTROL_ROOM_ROUTER_SETTINGS = "{not-json";
  __resetRouterSettingsCacheForTests();
  const s = getRouterSettings();
  assert.deepEqual(s, DEFAULT_ROUTER_SETTINGS);
  delete process.env.CONTROL_ROOM_ROUTER_SETTINGS;
  __resetRouterSettingsCacheForTests();
});

test("getRouterSettings caches the parsed value across calls in the same process", () => {
  process.env.CONTROL_ROOM_ROUTER_SETTINGS = JSON.stringify({ abEnabled: false });
  __resetRouterSettingsCacheForTests();
  const a = getRouterSettings();
  // Mutate the env var — the cache should still serve the old value.
  process.env.CONTROL_ROOM_ROUTER_SETTINGS = JSON.stringify({ abEnabled: true });
  const b = getRouterSettings();
  assert.equal(a, b);
  assert.equal(a.abEnabled, false);
  delete process.env.CONTROL_ROOM_ROUTER_SETTINGS;
  __resetRouterSettingsCacheForTests();
});
