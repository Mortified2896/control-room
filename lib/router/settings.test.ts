import assert from "node:assert/strict";
import test from "node:test";

import {
  __resetRouterSettingsCacheForTests,
  DEFAULT_ROUTER_SETTINGS,
  getRouterSettings,
  parseRouterSettings,
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

test("serializeRouterSettings round-trips through parseRouterSettings", () => {
  const overrides = {
    allowExpensiveModels: true,
    maxCostPerAbRunUsd: 0.42,
    fallbackModelId: "gpt-5.5",
    fallbackReasoningLevel: "medium" as const,
  };
  const serialized = serializeRouterSettings({ ...DEFAULT_ROUTER_SETTINGS, ...overrides });
  const parsed = parseRouterSettings(JSON.parse(serialized));
  assert.equal(parsed.allowExpensiveModels, true);
  assert.equal(parsed.maxCostPerAbRunUsd, 0.42);
  assert.equal(parsed.fallbackModelId, "gpt-5.5");
  assert.equal(parsed.fallbackReasoningLevel, "medium");
  // Unspecified fields keep their default.
  assert.equal(parsed.routerModelId, DEFAULT_ROUTER_SETTINGS.routerModelId);
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
