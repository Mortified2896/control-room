import assert from "node:assert/strict";
import test from "node:test";

import type { EffectiveRegistry } from "@/lib/providers/registry";
import { effortLevelsCapability, UNKNOWN_REASONING_CAPABILITY } from "@/lib/providers/capability";

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

test("default Router A/B is disabled", () => {
  assert.equal(DEFAULT_ROUTER_SETTINGS.abEnabled, false);
  assert.equal(parseRouterSettings({}).abEnabled, false);
});

test("default legacy A/B long-prompt threshold is 50000 characters", () => {
  assert.equal(DEFAULT_ROUTER_SETTINGS.longPromptThresholdChars, 50000);
  assert.equal(parseRouterSettings({}).longPromptThresholdChars, 50000);
});

test("saved/env Router A/B overrides are preserved over defaults", () => {
  const parsed = parseRouterSettings({ abEnabled: true, longPromptThresholdChars: 1500 });
  assert.equal(parsed.abEnabled, true);
  assert.equal(parsed.longPromptThresholdChars, 1500);
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

test("parseRouterSettings accepts provider-native reasoning values", () => {
  // The lenient parser accepts ANY non-empty provider-native value
  // — the per-model capability check lives in the strict
  // `parseRouterSettingsForSave` validator. Codex `xhigh`, MiniMax
  // `adaptive`, or any future provider-native value flows through
  // here without renaming.
  const parsed = parseRouterSettings({ fallbackReasoningLevel: "xhigh" });
  assert.equal(parsed.fallbackReasoningLevel, "xhigh");
  const parsedAdaptive = parseRouterSettings({ normalChatRecommenderReasoningLevel: "adaptive" });
  assert.equal(parsedAdaptive.normalChatRecommenderReasoningLevel, "adaptive");
});

test("parseRouterSettings rejects empty / non-string reasoning values", () => {
  // The lenient parser still rejects empty strings and non-string
  // values — a missing or malformed payload is never a valid pick.
  assert.throws(() => parseRouterSettings({ fallbackReasoningLevel: "" }));
  assert.throws(() => parseRouterSettings({ fallbackReasoningLevel: 42 as unknown as string }));
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

test("parseRouterSettings accepts provider-native allowedCombos values", () => {
  // The lenient parser accepts any non-empty provider-native value
  // — the per-model capability check lives in
  // `parseRouterSettingsForSave`. Codex `xhigh`, MiniMax `adaptive`,
  // or any future provider-native value flows through here
  // without renaming.
  const parsed = parseRouterSettings({
    allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "xhigh" }],
  });
  assert.equal(parsed.allowedCombos.length, 1);
  assert.equal(parsed.allowedCombos[0]?.reasoningLevel, "xhigh");
});

test("parseRouterSettings rejects malformed allowedCombos shape", () => {
  // Non-array values, empty reasoning levels, etc. are still
  // rejected. The validator only loosened the value check —
  // structural checks are unchanged.
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
          reasoningCapability: effortLevelsCapability(["low", "medium"], "supported"),
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

test("parseRouterSettingsForSave with registry: accepts a configured OpenAI model when allowOpenAiApiRouter is true and the model is not in the discovery snapshot", () => {
  // Mirrors the production scenario: `gpt-5.4-mini` is in the local
  // static alias map (configured=true) but OpenAI's live discovery
  // snapshot does not currently return it (e.g. the key lacks access
  // or the snapshot is stale). `/api/model/recommend` and `/api/chat`
  // both still use this model via `resolveModel`, so the router
  // settings validator must not reject it on `available`/`stale`
  // grounds. Only `configured`, the OpenAI provider, AND an explicit
  // opt-in (`allowOpenAiApiRouter`) are required when a registry is
  // supplied.
  const result = parseRouterSettingsForSave(
    {
      allowOpenAiApiRouter: true,
      allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
      routerModelId: "gpt-5.4-mini",
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
          reasoningCapability: effortLevelsCapability(["low", "medium"], "supported"),
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

test("parseRouterSettingsForSave with registry: accepts a Codex (codex:) model id under the subscription-first policy", () => {
  // Cost-safety: subscription providers (Codex) are accepted by default
  // under the subscription-first policy. The OpenAI-only normal-chat
  // router restriction has been lifted for subscription providers so
  // the cheap Codex login can be the default recommender / router. The
  // OpenAI API path is still gated behind `allowOpenAiApiRouter`.
  // The cast widens the test fixtures' providerId beyond the strict
  // "openai" literal in EffectiveRegistry — this matches what
  // `serializeRegistryModels` already does in the production route.
  const result = parseRouterSettingsForSave(
    {
      allowedCombos: [{ modelId: "codex:gpt-5.5", reasoningLevel: "low" }],
      routerModelId: "codex:gpt-5.5",
      fallbackModelId: "codex:gpt-5.5",
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
          reasoningCapability: effortLevelsCapability(["low", "medium"], "supported"),
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
          reasoningCapability: UNKNOWN_REASONING_CAPABILITY,
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
  if (!result.ok) {
    assert.fail(`expected Codex model to be accepted, got: ${JSON.stringify(result.errors)}`);
  }
  assert.equal(result.value.allowedCombos[0]?.modelId, "codex:gpt-5.5");
  assert.equal(result.value.routerModelId, "codex:gpt-5.5");
});

test("parseRouterSettingsForSave with registry: accepts a MiniMax model id under the subscription-first policy", () => {
  // Cost-safety: subscription providers (MiniMax) are accepted by
  // default under the subscription-first policy.
  const result = parseRouterSettingsForSave(
    {
      allowedCombos: [{ modelId: "MiniMax-M3", reasoningLevel: "low" }],
      routerModelId: "MiniMax-M3",
      fallbackModelId: "MiniMax-M3",
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
          reasoningCapability: effortLevelsCapability(["low", "medium"], "supported"),
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
          reasoningCapability: UNKNOWN_REASONING_CAPABILITY,
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
  if (!result.ok) {
    assert.fail(`expected MiniMax model to be accepted, got: ${JSON.stringify(result.errors)}`);
  }
  assert.equal(result.value.allowedCombos[0]?.modelId, "MiniMax-M3");
  assert.equal(result.value.routerModelId, "MiniMax-M3");
});

test("parseRouterSettingsForSave with registry: rejects an unconfigured (not in static map) model", () => {
  // Caller has opted into OpenAI API router use so we can exercise the
  // "not configured" rejection path (otherwise the model would be
  // rejected by the cheaper OpenAI API gate before the
  // configured=false branch).
  const result = parseRouterSettingsForSave(
    {
      allowOpenAiApiRouter: true,
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
          reasoningCapability: effortLevelsCapability(["low", "medium"], "supported"),
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
          reasoningCapability: UNKNOWN_REASONING_CAPABILITY,
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
  // Pass a registry that includes the Codex subscription default so
  // the registry-aware path can resolve `codex:gpt-5.4-mini`. The
  // defaults are subscription-first and never touch OpenAI API
  // unless the caller has explicitly opted in.
  const result = parseRouterSettingsForSave(DEFAULT_ROUTER_SETTINGS, {
    models: [
      {
        providerId: "codex",
        modelId: "codex:gpt-5.4-mini",
        displayLabel: "Codex · GPT-5.4 Mini",
        configured: true,
        available: true,
        stale: false,
        supportsReasoning: false,
        reasoningCapability: UNKNOWN_REASONING_CAPABILITY,
        supportedReasoningLevels: [],
        tier: "standard",
        usableForChat: true,
        manualSelectorVisible: true,
        manuallyOverridden: false,
        routerEligible: true,
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
    defaults: { manualModelId: "codex:gpt-5.4-mini", reasoningLevel: "low" },
    discovery: {
      modelIds: ["codex:gpt-5.4-mini"],
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
  } as unknown as EffectiveRegistry);
  if (!result.ok) {
    assert.fail(`expected defaults to pass validation, got: ${JSON.stringify(result.errors)}`);
  }
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

test("parseRouterSettings accepts a normalChatRecommenderModelId override", () => {
  const parsed = parseRouterSettings({
    normalChatRecommenderModelId: "MiniMax-M3",
  });
  assert.equal(parsed.normalChatRecommenderModelId, "MiniMax-M3");
});

test("parseRouterSettings rejects an empty normalChatRecommenderModelId", () => {
  assert.throws(
    () => parseRouterSettings({ normalChatRecommenderModelId: "  " }),
    /non-empty string/,
  );
});

test("parseRouterSettingsForSave rejects an empty normalChatRecommenderModelId", () => {
  const result = parseRouterSettingsForSave({
    normalChatRecommenderModelId: "   ",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.errors.some((e) => e.field === "normalChatRecommenderModelId"),
      "expected a normalChatRecommenderModelId error",
    );
  }
});

test("parseRouterSettingsForSave with registry: rejects an OpenAI normalChatRecommenderModelId when allowOpenAiApiRouter is off", () => {
  // Same cost-safety gate as routerModelId: an OpenAI API model is
  // not a valid recommender unless the user has explicitly opted in
  // via `allowOpenAiApiRouter`.
  const result = parseRouterSettingsForSave(
    {
      // allowOpenAiApiRouter defaults to false; we leave it off.
      normalChatRecommenderModelId: "gpt-5.4-mini",
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
          reasoningCapability: effortLevelsCapability(["low", "medium"], "supported"),
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
    } as unknown as EffectiveRegistry,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.errors.some(
        (e) =>
          e.field === "normalChatRecommenderModelId" &&
          /OpenAI API router use is disabled/.test(e.message),
      ),
      "expected OpenAI-API cost-safety error on the recommender field",
    );
  }
});

test("parseRouterSettingsForSave with registry: accepts a Codex normalChatRecommenderModelId by default", () => {
  // The default (subscription-first) policy accepts Codex / MiniMax
  // as the recommender without an opt-in. The recommender is
  // independent of routerModelId so users can pick different models
  // for each surface.
  const result = parseRouterSettingsForSave(
    {
      normalChatRecommenderModelId: "codex:gpt-5.5",
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
          reasoningCapability: effortLevelsCapability(["low", "medium"], "supported"),
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
          reasoningCapability: UNKNOWN_REASONING_CAPABILITY,
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
  if (!result.ok) {
    assert.fail(`expected Codex recommender to be accepted, got: ${JSON.stringify(result.errors)}`);
  }
  assert.equal(result.value.normalChatRecommenderModelId, "codex:gpt-5.5");
});

// ---------------------------------------------------------------------------
// normalChatRecommenderAllowedModels
// ---------------------------------------------------------------------------

test("parseRouterSettings accepts a null normalChatRecommenderAllowedModels (no restriction)", () => {
  const parsed = parseRouterSettings({ normalChatRecommenderAllowedModels: null });
  assert.equal(parsed.normalChatRecommenderAllowedModels, null);
});

test("parseRouterSettings accepts an array of model ids", () => {
  const parsed = parseRouterSettings({
    normalChatRecommenderAllowedModels: ["gpt-5.4-mini", "MiniMax-M3"],
  });
  assert.deepEqual(parsed.normalChatRecommenderAllowedModels, ["gpt-5.4-mini", "MiniMax-M3"]);
});

test("parseRouterSettings rejects a non-array / non-null normalChatRecommenderAllowedModels", () => {
  assert.throws(
    () => parseRouterSettings({ normalChatRecommenderAllowedModels: "gpt-5.4-mini" }),
    /null or an array/,
  );
  assert.throws(
    () => parseRouterSettings({ normalChatRecommenderAllowedModels: 42 }),
    /null or an array/,
  );
});

test("parseRouterSettings rejects blank or non-string entries in normalChatRecommenderAllowedModels", () => {
  assert.throws(
    () => parseRouterSettings({ normalChatRecommenderAllowedModels: ["gpt-5.4-mini", "  "] }),
    /non-empty strings/,
  );
  assert.throws(
    () => parseRouterSettings({ normalChatRecommenderAllowedModels: [42] }),
    /non-empty strings/,
  );
});

test("parseRouterSettingsForSave accepts null normalChatRecommenderAllowedModels", () => {
  const result = parseRouterSettingsForSave({
    allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
    fallbackModelId: "gpt-5.4-mini",
    fallbackReasoningLevel: "low",
    normalChatRecommenderAllowedModels: null,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.normalChatRecommenderAllowedModels, null);
  }
});

test("parseRouterSettingsForSave accepts an empty array (block all)", () => {
  const result = parseRouterSettingsForSave({
    allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
    fallbackModelId: "gpt-5.4-mini",
    fallbackReasoningLevel: "low",
    normalChatRecommenderAllowedModels: [],
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.normalChatRecommenderAllowedModels, []);
  }
});

test("parseRouterSettingsForSave accepts an array of model ids and dedupes", () => {
  const result = parseRouterSettingsForSave({
    allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
    fallbackModelId: "gpt-5.4-mini",
    fallbackReasoningLevel: "low",
    normalChatRecommenderAllowedModels: ["gpt-5.4-mini", "gpt-5.4-mini", "MiniMax-M3"],
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.normalChatRecommenderAllowedModels, [
      "gpt-5.4-mini",
      "MiniMax-M3",
    ]);
  }
});

test("parseRouterSettingsForSave rejects a non-array / non-null normalChatRecommenderAllowedModels", () => {
  const result = parseRouterSettingsForSave({
    allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
    fallbackModelId: "gpt-5.4-mini",
    fallbackReasoningLevel: "low",
    normalChatRecommenderAllowedModels: "gpt-5.4-mini",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.errors.some((e) => e.field === "normalChatRecommenderAllowedModels"),
      `expected a normalChatRecommenderAllowedModels error, got: ${JSON.stringify(result.errors)}`,
    );
  }
});

test("parseRouterSettingsForSave rejects blank entries in normalChatRecommenderAllowedModels", () => {
  const result = parseRouterSettingsForSave({
    allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
    fallbackModelId: "gpt-5.4-mini",
    fallbackReasoningLevel: "low",
    normalChatRecommenderAllowedModels: ["gpt-5.4-mini", ""],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.errors.some((e) => e.field === "normalChatRecommenderAllowedModels"),
      `expected a normalChatRecommenderAllowedModels error, got: ${JSON.stringify(result.errors)}`,
    );
  }
});

test("parseRouterSettingsForSave accepts an allowlist with unknown model ids (permissive)", () => {
  // The validator must not reject unknown ids — the runtime filter in
  // /api/model/recommend silently drops them so the recommender never
  // suggests a model the user can't call.
  const result = parseRouterSettingsForSave({
    allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
    fallbackModelId: "gpt-5.4-mini",
    fallbackReasoningLevel: "low",
    normalChatRecommenderAllowedModels: ["gpt-5.4-mini", "completely-unknown-id"],
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.normalChatRecommenderAllowedModels, [
      "gpt-5.4-mini",
      "completely-unknown-id",
    ]);
  }
});

test("getRouterSettings env-var round-trip preserves the recommender allowlist", () => {
  const previousEnv = process.env.CONTROL_ROOM_ROUTER_SETTINGS;
  process.env.CONTROL_ROOM_ROUTER_SETTINGS = JSON.stringify({
    normalChatRecommenderAllowedModels: ["gpt-5.4-mini", "MiniMax-M3"],
  });
  __resetRouterSettingsCacheForTests();
  try {
    const settings = getRouterSettings();
    assert.deepEqual(settings.normalChatRecommenderAllowedModels, ["gpt-5.4-mini", "MiniMax-M3"]);
  } finally {
    if (previousEnv === undefined) {
      delete process.env.CONTROL_ROOM_ROUTER_SETTINGS;
    } else {
      process.env.CONTROL_ROOM_ROUTER_SETTINGS = previousEnv;
    }
    __resetRouterSettingsCacheForTests();
  }
});

test("DEFAULT_ROUTER_SETTINGS.normalChatRecommenderAllowedModels is null (no restriction)", () => {
  assert.equal(DEFAULT_ROUTER_SETTINGS.normalChatRecommenderAllowedModels, null);
});

test("serializeRouterSettings round-trips normalChatRecommenderAllowedModels", () => {
  const serialized = serializeRouterSettings({
    ...DEFAULT_ROUTER_SETTINGS,
    normalChatRecommenderAllowedModels: ["gpt-5.4-mini", "MiniMax-M3"],
  });
  const roundTripped = parseRouterSettings(JSON.parse(serialized));
  assert.deepEqual(roundTripped.normalChatRecommenderAllowedModels, ["gpt-5.4-mini", "MiniMax-M3"]);
});

// ---------------------------------------------------------------------------
// normalChatRecommenderReasoningLevel
// ---------------------------------------------------------------------------

test("parseRouterSettings accepts a normalChatRecommenderReasoningLevel override", () => {
  const parsed = parseRouterSettings({
    normalChatRecommenderReasoningLevel: "high",
  });
  assert.equal(parsed.normalChatRecommenderReasoningLevel, "high");
});

test("parseRouterSettings accepts a provider-native normalChatRecommenderReasoningLevel", () => {
  // Provider-native values flow through the lenient parser
  // unchanged. The per-model capability check lives in
  // `parseRouterSettingsForSave`.
  const parsed = parseRouterSettings({
    normalChatRecommenderReasoningLevel: "xhigh",
  });
  assert.equal(parsed.normalChatRecommenderReasoningLevel, "xhigh");
});

test("parseRouterSettings rejects an empty normalChatRecommenderReasoningLevel", () => {
  // Empty / non-string values are still rejected — a missing or
  // malformed payload is never a valid pick.
  assert.throws(() => parseRouterSettings({ normalChatRecommenderReasoningLevel: "" }));
});

test("parseRouterSettingsForSave accepts normalChatRecommenderReasoningLevel", () => {
  const result = parseRouterSettingsForSave(
    {
      allowedCombos: [{ modelId: "codex:gpt-5.4-mini", reasoningLevel: "low" }],
      fallbackModelId: "codex:gpt-5.4-mini",
      fallbackReasoningLevel: "low",
      normalChatRecommenderReasoningLevel: "high",
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
          reasoningCapability: effortLevelsCapability(["low", "medium"], "supported"),
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
        manualSelectorVisible: 2,
        routerEligible: 1,
      },
      fakeMode: false,
    } as unknown as EffectiveRegistry,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.normalChatRecommenderReasoningLevel, "high");
  }
});

test("parseRouterSettingsForSave accepts any non-empty normalChatRecommenderReasoningLevel", () => {
  // Provider-native values flow through the strict validator too —
  // the per-model capability check lives in `allowedCombos` /
  // `fallbackReasoningLevel` validation (which compares against the
  // registry). The recommender field is a single string the user
  // picks for the recommender model; the runtime adapter validates
  // it against the recommender's capability at call time.
  const result = parseRouterSettingsForSave(
    {
      allowedCombos: [{ modelId: "codex:gpt-5.4-mini", reasoningLevel: "low" }],
      fallbackModelId: "codex:gpt-5.4-mini",
      fallbackReasoningLevel: "low",
      normalChatRecommenderReasoningLevel: "adaptive",
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
          reasoningCapability: effortLevelsCapability(["low", "medium"], "supported"),
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
        manualSelectorVisible: 2,
        routerEligible: 1,
      },
      fakeMode: false,
    } as unknown as EffectiveRegistry,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.normalChatRecommenderReasoningLevel, "adaptive");
  }
});

test("parseRouterSettingsForSave rejects an empty normalChatRecommenderReasoningLevel", () => {
  // Empty / non-string values are still rejected — a missing or
  // malformed payload is never a valid pick.
  const result = parseRouterSettingsForSave(
    {
      allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
      fallbackModelId: "gpt-5.4-mini",
      fallbackReasoningLevel: "low",
      normalChatRecommenderReasoningLevel: "",
    },
    {
      models: [],
    } as unknown as EffectiveRegistry,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((e) => e.field === "normalChatRecommenderReasoningLevel"));
  }
});

test("DEFAULT_ROUTER_SETTINGS.normalChatRecommenderReasoningLevel defaults to low", () => {
  assert.equal(DEFAULT_ROUTER_SETTINGS.normalChatRecommenderReasoningLevel, "low");
});

test("serializeRouterSettings round-trips normalChatRecommenderReasoningLevel", () => {
  const serialized = serializeRouterSettings({
    ...DEFAULT_ROUTER_SETTINGS,
    normalChatRecommenderReasoningLevel: "high",
  });
  const roundTripped = parseRouterSettings(JSON.parse(serialized));
  assert.equal(roundTripped.normalChatRecommenderReasoningLevel, "high");
});

// ---------------------------------------------------------------------------
// normalChatRecommenderFallbackModelId + normalChatRecommenderFallbackReasoningLevel
// ---------------------------------------------------------------------------

test("DEFAULT_ROUTER_SETTINGS.normalChatRecommenderFallbackModelId is null", () => {
  assert.equal(DEFAULT_ROUTER_SETTINGS.normalChatRecommenderFallbackModelId, null);
});

test("DEFAULT_ROUTER_SETTINGS.normalChatRecommenderFallbackReasoningLevel is null", () => {
  assert.equal(DEFAULT_ROUTER_SETTINGS.normalChatRecommenderFallbackReasoningLevel, null);
});

test("parseRouterSettings accepts a normalChatRecommenderFallbackModelId override", () => {
  const parsed = parseRouterSettings({
    normalChatRecommenderFallbackModelId: "MiniMax-M3",
  });
  assert.equal(parsed.normalChatRecommenderFallbackModelId, "MiniMax-M3");
});

test("parseRouterSettings accepts a null normalChatRecommenderFallbackModelId", () => {
  // The lenient parser must round-trip `null` through (the user can
  // explicitly clear the fallback via the Settings UI).
  const parsed = parseRouterSettings({
    normalChatRecommenderFallbackModelId: null,
  });
  assert.equal(parsed.normalChatRecommenderFallbackModelId, null);
});

test("parseRouterSettings rejects an empty / non-string normalChatRecommenderFallbackModelId", () => {
  assert.throws(
    () => parseRouterSettings({ normalChatRecommenderFallbackModelId: "  " }),
    /null or a non-empty string/,
  );
  assert.throws(
    () => parseRouterSettings({ normalChatRecommenderFallbackModelId: 42 }),
    /null or a non-empty string/,
  );
});

test("parseRouterSettings accepts a normalChatRecommenderFallbackReasoningLevel override", () => {
  const parsed = parseRouterSettings({
    normalChatRecommenderFallbackReasoningLevel: "medium",
  });
  assert.equal(parsed.normalChatRecommenderFallbackReasoningLevel, "medium");
});

test("parseRouterSettings accepts a null normalChatRecommenderFallbackReasoningLevel", () => {
  const parsed = parseRouterSettings({
    normalChatRecommenderFallbackReasoningLevel: null,
  });
  assert.equal(parsed.normalChatRecommenderFallbackReasoningLevel, null);
});

test("parseRouterSettings rejects an empty / non-string normalChatRecommenderFallbackReasoningLevel", () => {
  assert.throws(
    () => parseRouterSettings({ normalChatRecommenderFallbackReasoningLevel: "" }),
    /null or a non-empty provider-native value/,
  );
  assert.throws(
    () => parseRouterSettings({ normalChatRecommenderFallbackReasoningLevel: 42 }),
    /null or a non-empty provider-native value/,
  );
});

test("parseRouterSettingsForSave accepts a normalChatRecommenderFallbackModelId", () => {
  // Without a registry, the legacy validator uses
  // `listRouterAllowedPool` which only knows about OpenAI models.
  // We use an OpenAI id here so the legacy path accepts it; the
  // registry-aware path is covered separately below.
  const result = parseRouterSettingsForSave({
    allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
    fallbackModelId: "gpt-5.4-mini",
    fallbackReasoningLevel: "low",
    allowOpenAiApiRouter: true,
    normalChatRecommenderFallbackModelId: "gpt-5.4-mini",
    normalChatRecommenderFallbackReasoningLevel: "low",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.normalChatRecommenderFallbackModelId, "gpt-5.4-mini");
    assert.equal(result.value.normalChatRecommenderFallbackReasoningLevel, "low");
  }
});

test("parseRouterSettingsForSave accepts a null fallback model", () => {
  // Without a registry, the legacy validator uses
  // `listRouterAllowedPool` (OpenAI-only). We use an OpenAI id here
  // so the legacy path accepts it.
  const result = parseRouterSettingsForSave({
    allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
    fallbackModelId: "gpt-5.4-mini",
    fallbackReasoningLevel: "low",
    allowOpenAiApiRouter: true,
    normalChatRecommenderFallbackModelId: null,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.normalChatRecommenderFallbackModelId, null);
  }
});

test("parseRouterSettingsForSave rejects a reasoning level with no fallback model", () => {
  // Cross-field invariant: the fallback reasoning level must be null
  // when no fallback model is configured. This is enforced so the
  // persisted payload never has a dangling reasoning level for a
  // missing fallback.
  const result = parseRouterSettingsForSave({
    allowedCombos: [{ modelId: "codex:gpt-5.4-mini", reasoningLevel: "low" }],
    fallbackModelId: "codex:gpt-5.4-mini",
    fallbackReasoningLevel: "low",
    normalChatRecommenderFallbackModelId: null,
    normalChatRecommenderFallbackReasoningLevel: "low",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.errors.some(
        (e) =>
          e.field === "normalChatRecommenderFallbackReasoningLevel" &&
          /must be null when no fallback model/.test(e.message),
      ),
      `expected a fallback reasoning level cross-field error, got: ${JSON.stringify(result.errors)}`,
    );
  }
});

test("parseRouterSettingsForSave rejects an empty / non-string fallback model id", () => {
  const result = parseRouterSettingsForSave({
    allowedCombos: [{ modelId: "codex:gpt-5.4-mini", reasoningLevel: "low" }],
    fallbackModelId: "codex:gpt-5.4-mini",
    fallbackReasoningLevel: "low",
    normalChatRecommenderFallbackModelId: "  ",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.errors.some((e) => e.field === "normalChatRecommenderFallbackModelId"),
      `expected a fallback model id error, got: ${JSON.stringify(result.errors)}`,
    );
  }
});

test("parseRouterSettingsForSave with registry: accepts a Codex subscription fallback", () => {
  // Subscription providers are accepted by default under the
  // subscription-first policy.
  const result = parseRouterSettingsForSave(
    {
      allowedCombos: [{ modelId: "codex:gpt-5.4-mini", reasoningLevel: "low" }],
      fallbackModelId: "codex:gpt-5.4-mini",
      fallbackReasoningLevel: "low",
      normalChatRecommenderFallbackModelId: "codex:gpt-5.5",
      normalChatRecommenderFallbackReasoningLevel: "low",
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
          reasoningCapability: effortLevelsCapability(["low", "medium"], "supported"),
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
          reasoningCapability: UNKNOWN_REASONING_CAPABILITY,
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
  if (!result.ok) {
    assert.fail(`expected Codex fallback to be accepted, got: ${JSON.stringify(result.errors)}`);
  }
  assert.equal(result.value.normalChatRecommenderFallbackModelId, "codex:gpt-5.5");
});

test("parseRouterSettingsForSave with registry: rejects an OpenAI fallback when allowOpenAiApiRouter is off", () => {
  const result = parseRouterSettingsForSave(
    {
      allowedCombos: [{ modelId: "gpt-5.4-mini", reasoningLevel: "low" }],
      fallbackModelId: "gpt-5.4-mini",
      fallbackReasoningLevel: "low",
      normalChatRecommenderFallbackModelId: "gpt-5.5",
      normalChatRecommenderFallbackReasoningLevel: "low",
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
          reasoningCapability: effortLevelsCapability(["low", "medium"], "supported"),
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
          modelId: "gpt-5.5",
          displayLabel: "GPT-5.5",
          configured: true,
          available: true,
          stale: false,
          supportsReasoning: true,
          reasoningCapability: effortLevelsCapability(["low", "medium"], "supported"),
          supportedReasoningLevels: ["low", "medium"],
          tier: "expensive",
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
        modelIds: ["gpt-5.4-mini", "gpt-5.5"],
        previousModelIds: [],
        fetchedAt: new Date(),
        httpStatus: 200,
        source: "openai",
        rawCount: 2,
        errorMessage: null,
        updatedAt: new Date(),
      },
      selectorPrefs: {},
      counts: {
        discovered: 2,
        discoveredConfigured: 2,
        discoveredUnclassified: 0,
        configuredAvailable: 2,
        stale: 0,
        manualSelectorVisible: 2,
        routerEligible: 2,
      },
      fakeMode: false,
    } as unknown as EffectiveRegistry,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.errors.some(
        (e) =>
          e.field === "normalChatRecommenderFallbackModelId" &&
          /OpenAI API router use is disabled/.test(e.message),
      ),
      `expected an OpenAI-API cost-safety error, got: ${JSON.stringify(result.errors)}`,
    );
  }
});

test("serializeRouterSettings round-trips normalChatRecommenderFallbackModelId", () => {
  const serialized = serializeRouterSettings({
    ...DEFAULT_ROUTER_SETTINGS,
    normalChatRecommenderFallbackModelId: "MiniMax-M3",
    normalChatRecommenderFallbackReasoningLevel: "low",
  });
  const roundTripped = parseRouterSettings(JSON.parse(serialized));
  assert.equal(roundTripped.normalChatRecommenderFallbackModelId, "MiniMax-M3");
  assert.equal(roundTripped.normalChatRecommenderFallbackReasoningLevel, "low");
});

test("serializeRouterSettings round-trips a null normalChatRecommenderFallbackModelId", () => {
  const serialized = serializeRouterSettings({
    ...DEFAULT_ROUTER_SETTINGS,
    normalChatRecommenderFallbackModelId: null,
    normalChatRecommenderFallbackReasoningLevel: null,
  });
  const roundTripped = parseRouterSettings(JSON.parse(serialized));
  assert.equal(roundTripped.normalChatRecommenderFallbackModelId, null);
  assert.equal(roundTripped.normalChatRecommenderFallbackReasoningLevel, null);
});

test("getRouterSettings env-var round-trip preserves the fallback fields", () => {
  const previousEnv = process.env.CONTROL_ROOM_ROUTER_SETTINGS;
  process.env.CONTROL_ROOM_ROUTER_SETTINGS = JSON.stringify({
    normalChatRecommenderFallbackModelId: "MiniMax-M3",
    normalChatRecommenderFallbackReasoningLevel: "low",
  });
  __resetRouterSettingsCacheForTests();
  try {
    const settings = getRouterSettings();
    assert.equal(settings.normalChatRecommenderFallbackModelId, "MiniMax-M3");
    assert.equal(settings.normalChatRecommenderFallbackReasoningLevel, "low");
  } finally {
    if (previousEnv === undefined) {
      delete process.env.CONTROL_ROOM_ROUTER_SETTINGS;
    } else {
      process.env.CONTROL_ROOM_ROUTER_SETTINGS = previousEnv;
    }
    __resetRouterSettingsCacheForTests();
  }
});
