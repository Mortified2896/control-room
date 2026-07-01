import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CODING_MODEL_ROUTING_SETTINGS,
  parseCodingModelRoutingSettings,
} from "./coding-model-routing-settings";

test("default coding model routing settings parse as valid", () => {
  const parsed = parseCodingModelRoutingSettings(DEFAULT_CODING_MODEL_ROUTING_SETTINGS);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.defaultRouteModel, "codex:gpt-5.5");
    assert.equal(parsed.value.defaultRouteFallbackModel, "MiniMax-M3");
    assert.equal(parsed.value.largeContextRouteModel, "codex:gpt-5.5");
    assert.equal(parsed.value.largeContextRouteFallbackModel, "MiniMax-M3");
    assert.equal(parsed.value.thresholdTokens, 120000);
    assert.deepEqual(parsed.value.fallbackReasons, ["usage_limit", "rate_limit", "internal"]);
  }
});

test("saving valid coding model routing settings with both route fallback fields works", () => {
  const parsed = parseCodingModelRoutingSettings({
    defaultRouteModel: "gpt-5.4",
    defaultRouteFallbackModel: "MiniMax-M3",
    largeContextRouteModel: "gpt-5.5",
    largeContextRouteFallbackModel: "MiniMax-M3",
    thresholdTokens: 200000,
    fallbackReasons: ["usage_limit", "rate_limit"],
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.largeContextRouteFallbackModel, "MiniMax-M3");
});

test("invalid route model ids are rejected", () => {
  const parsed = parseCodingModelRoutingSettings({ ...DEFAULT_CODING_MODEL_ROUTING_SETTINGS, defaultRouteModel: "fake-model" });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.errors.map((e) => e.message).join(" "), /Unknown coding harness model id/);
});

test("invalid default-route fallback model is rejected", () => {
  const parsed = parseCodingModelRoutingSettings({ ...DEFAULT_CODING_MODEL_ROUTING_SETTINGS, defaultRouteFallbackModel: "fake-model" });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.errors[0]?.field, "defaultRouteFallbackModel");
});

test("invalid large-context fallback model is rejected", () => {
  const parsed = parseCodingModelRoutingSettings({ ...DEFAULT_CODING_MODEL_ROUTING_SETTINGS, largeContextRouteFallbackModel: "fake-model" });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.errors[0]?.field, "largeContextRouteFallbackModel");
});

test("invalid threshold is rejected", () => {
  const parsed = parseCodingModelRoutingSettings({ ...DEFAULT_CODING_MODEL_ROUTING_SETTINGS, thresholdTokens: 0 });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.errors[0]?.field, "thresholdTokens");
});

test("unknown fallback reason is rejected", () => {
  const parsed = parseCodingModelRoutingSettings({ ...DEFAULT_CODING_MODEL_ROUTING_SETTINGS, fallbackReasons: ["auth"] });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.errors[0]?.message ?? "", /Unknown fallback reason/);
});

test("unknown usage cannot be configured as fallback", () => {
  const parsed = parseCodingModelRoutingSettings({ ...DEFAULT_CODING_MODEL_ROUTING_SETTINGS, fallbackReasons: ["unknown_usage"] });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.errors[0]?.message ?? "", /Unknown usage cannot/);
});

test("legacy global failureFallbackModel settings normalize safely", () => {
  const parsed = parseCodingModelRoutingSettings({
    standardModel: "gpt-5.5-small",
    largeContextModel: "codex:gpt-5.5-small",
    thresholdTokens: 120000,
    failureFallbackModel: "MiniMax-M3",
    enabledFallbackReasons: ["usage_limit", "rate_limit", "internal"],
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.defaultRouteModel, "codex:gpt-5.5");
    assert.equal(parsed.value.largeContextRouteModel, "codex:gpt-5.5");
    assert.equal(parsed.value.defaultRouteFallbackModel, "MiniMax-M3");
    assert.equal(parsed.value.largeContextRouteFallbackModel, "MiniMax-M3");
  }
});
