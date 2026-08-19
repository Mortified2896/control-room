import test from "node:test";
import assert from "node:assert/strict";

import {
  CHEAP_TIER_REASONING_EFFORT_VALUES,
  FULL_REASONING_EFFORT_VALUES,
  MINIMAX_THINKING_MODE_VALUES,
  describeReasoningCapability,
  effortLevelsCapability,
  getEffortLevelOptionValues,
  getEffectiveReasoningLevels,
  getThinkingModeOptionValues,
  hasReasoningControls,
  isReasoningOptionValid,
  noReasoningCapability,
  resolveDefaultReasoningOption,
  thinkingBudgetCapability,
  UNKNOWN_REASONING_CAPABILITY,
  unknownReasoningCapability,
} from "./capability";
import { ProviderAccessError, validateReasoningLevelForCapability } from "./access-control";

test("isReasoningOptionValid accepts provider-native effort values", () => {
  const cap = effortLevelsCapability(
    ["none", "minimal", "low", "medium", "high", "xhigh"],
    "supported",
  );
  for (const value of ["none", "minimal", "low", "medium", "high", "xhigh"]) {
    assert.equal(isReasoningOptionValid(cap, value), true);
  }
});

test("getEffectiveReasoningLevels returns the full provider-native set for effort_levels + supported", () => {
  const cap = effortLevelsCapability(
    ["none", "minimal", "low", "medium", "high", "xhigh"],
    "supported",
  );
  assert.deepEqual(getEffectiveReasoningLevels(cap), [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
});

test("getEffectiveReasoningLevels returns the conservative set for effort_levels + model_dependent", () => {
  const cap = effortLevelsCapability(["low"], "model_dependent");
  assert.deepEqual(getEffectiveReasoningLevels(cap), ["low"]);
});

test("getEffectiveReasoningLevels returns an empty array for effort_levels + unknown", () => {
  // The brief explicitly says: do NOT fake low/medium/high options
  // when the surface is unknown.
  const cap = effortLevelsCapability([], "unknown");
  assert.deepEqual(getEffectiveReasoningLevels(cap), []);
});

test("getEffectiveReasoningLevels returns an empty array for thinking_budget", () => {
  // Thinking-budget is a different shape than effort levels; the
  // legacy field must not surface fake low/medium/high options.
  const cap = thinkingBudgetCapability("supported", {
    modes: MINIMAX_THINKING_MODE_VALUES,
  });
  assert.deepEqual(getEffectiveReasoningLevels(cap), []);
});

test("getEffectiveReasoningLevels returns an empty array for none and unknown kinds", () => {
  assert.deepEqual(getEffectiveReasoningLevels(noReasoningCapability()), []);
  assert.deepEqual(getEffectiveReasoningLevels(UNKNOWN_REASONING_CAPABILITY), []);
});

test("getEffectiveReasoningLevels does NOT narrow to a fixed enum", () => {
  // Provider-native values like `none`, `minimal`, `xhigh` flow
  // through unchanged. The capability model does NOT remap them
  // to a fixed low | medium | high triple.
  const cap = effortLevelsCapability(["none", "minimal", "low", "xhigh"], "supported");
  const values = getEffectiveReasoningLevels(cap);
  assert.ok(values.includes("none"));
  assert.ok(values.includes("minimal"));
  assert.ok(values.includes("xhigh"));
});

test("hasReasoningControls agrees with the capability kind/control", () => {
  assert.equal(hasReasoningControls(effortLevelsCapability(["low"], "supported")), true);
  assert.equal(hasReasoningControls(effortLevelsCapability(["low"], "model_dependent")), true);
  assert.equal(hasReasoningControls(effortLevelsCapability([], "unknown")), false);
  assert.equal(hasReasoningControls(thinkingBudgetCapability("supported")), true);
  assert.equal(hasReasoningControls(thinkingBudgetCapability("model_dependent")), true);
  assert.equal(hasReasoningControls(thinkingBudgetCapability("unknown")), false);
  assert.equal(hasReasoningControls(noReasoningCapability()), false);
  assert.equal(hasReasoningControls(UNKNOWN_REASONING_CAPABILITY), false);
});

test("getEffortLevelOptionValues returns the provider-native values for effort_levels", () => {
  const cap = effortLevelsCapability(
    ["none", "minimal", "low", "medium", "high", "xhigh"],
    "supported",
  );
  assert.deepEqual(getEffortLevelOptionValues(cap), [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
});

test("getEffortLevelOptionValues returns an empty array for non-effort-level capabilities", () => {
  assert.deepEqual(getEffortLevelOptionValues(thinkingBudgetCapability("supported")), []);
  assert.deepEqual(getEffortLevelOptionValues(noReasoningCapability()), []);
  assert.deepEqual(getEffortLevelOptionValues(UNKNOWN_REASONING_CAPABILITY), []);
});

test("getThinkingModeOptionValues returns the provider-native values for thinking_budget", () => {
  const cap = thinkingBudgetCapability("supported", {
    modes: ["provider_default", "adaptive", "enabled", "disabled"],
  });
  assert.deepEqual(getThinkingModeOptionValues(cap), [
    "provider_default",
    "adaptive",
    "enabled",
    "disabled",
  ]);
});

test("getThinkingModeOptionValues returns an empty array when modes are omitted", () => {
  const cap = thinkingBudgetCapability("supported");
  assert.deepEqual(getThinkingModeOptionValues(cap), []);
});

test("resolveDefaultReasoningOption returns the explicit defaultOption when present", () => {
  const cap = effortLevelsCapability(["low", "medium", "high"], "supported", {
    defaultOption: "medium",
  });
  assert.equal(resolveDefaultReasoningOption(cap), "medium");
});

test("resolveDefaultReasoningOption falls back to the first option", () => {
  const cap = effortLevelsCapability(["xhigh", "high"], "supported");
  assert.equal(resolveDefaultReasoningOption(cap), "xhigh");
});

test("resolveDefaultReasoningOption returns null for unknown / none", () => {
  assert.equal(resolveDefaultReasoningOption(UNKNOWN_REASONING_CAPABILITY), null);
  assert.equal(resolveDefaultReasoningOption(noReasoningCapability()), null);
});

test("resolveDefaultReasoningOption handles thinking_budget fallback to 'enabled'", () => {
  // When the thinking_budget capability supports an enabled toggle
  // but does not advertise explicit modes, fall back to "enabled"
  // as the safe default.
  const cap = thinkingBudgetCapability("supported", { supportsEnabled: true });
  assert.equal(resolveDefaultReasoningOption(cap), "enabled");
});

test("isReasoningOptionValid accepts provider-native effort values", () => {
  const cap = effortLevelsCapability(
    ["none", "minimal", "low", "medium", "high", "xhigh"],
    "supported",
  );
  for (const value of ["none", "minimal", "low", "medium", "high", "xhigh"]) {
    assert.equal(isReasoningOptionValid(cap, value), true);
  }
});

test("isReasoningOptionValid rejects stale values", () => {
  // After a provider refresh removed `xhigh`, the saved pick is
  // no longer valid. The validator surfaces this so the chat
  // route falls back to the provider default.
  const before = effortLevelsCapability(
    ["none", "minimal", "low", "medium", "high", "xhigh"],
    "supported",
  );
  const after = effortLevelsCapability(["none", "low", "medium", "high"], "supported");
  assert.equal(isReasoningOptionValid(before, "xhigh"), true);
  assert.equal(isReasoningOptionValid(after, "xhigh"), false);
});

test("isReasoningOptionValid rejects null / undefined / empty", () => {
  const cap = effortLevelsCapability(["low"], "supported");
  assert.equal(isReasoningOptionValid(cap, null), false);
  assert.equal(isReasoningOptionValid(cap, undefined), false);
  assert.equal(isReasoningOptionValid(cap, ""), false);
});

test("isReasoningOptionValid accepts provider-native thinking modes", () => {
  const cap = thinkingBudgetCapability("supported", {
    modes: MINIMAX_THINKING_MODE_VALUES,
  });
  for (const mode of MINIMAX_THINKING_MODE_VALUES) {
    assert.equal(isReasoningOptionValid(cap, mode), true);
  }
});

test("isReasoningOptionValid accepts enabled/disabled for thinking_budget that supports the toggle", () => {
  const cap = thinkingBudgetCapability("supported", {
    supportsEnabled: true,
  });
  assert.equal(isReasoningOptionValid(cap, "enabled"), true);
  assert.equal(isReasoningOptionValid(cap, "disabled"), true);
});

test("isReasoningOptionValid rejects arbitrary strings for thinking_budget", () => {
  const cap = thinkingBudgetCapability("supported");
  assert.equal(isReasoningOptionValid(cap, "ultra"), false);
});

test("describeReasoningCapability returns short human-readable labels", () => {
  assert.equal(
    describeReasoningCapability(effortLevelsCapability(["low"], "supported")),
    "Reasoning effort",
  );
  assert.equal(
    describeReasoningCapability(effortLevelsCapability(["low"], "model_dependent")),
    "Reasoning effort (model-dependent)",
  );
  assert.equal(
    describeReasoningCapability(effortLevelsCapability([], "unknown")),
    "Reasoning effort (unknown)",
  );
  assert.equal(
    describeReasoningCapability(thinkingBudgetCapability("supported")),
    "Thinking budget",
  );
  assert.equal(
    describeReasoningCapability(thinkingBudgetCapability("model_dependent")),
    "Thinking budget (model-dependent)",
  );
  assert.equal(
    describeReasoningCapability(thinkingBudgetCapability("unknown")),
    "Thinking budget (unknown)",
  );
  assert.equal(describeReasoningCapability(noReasoningCapability()), "Reasoning not supported");
  assert.equal(
    describeReasoningCapability(unknownReasoningCapability()),
    "Reasoning capability unknown",
  );
});

test("effortLevelsCapability constructor accepts non-legacy provider-native values", () => {
  const cap = effortLevelsCapability(
    ["none", "minimal", "low", "medium", "high", "xhigh"],
    "supported",
    { defaultOption: "low", source: "static" },
  );
  assert.equal(cap.kind, "effort_levels");
  assert.equal(cap.control, "supported");
  assert.equal(cap.defaultOption, "low");
  assert.equal(cap.source, "static");
  assert.equal(cap.options.length, 6);
  // Each option carries the provider-native value verbatim.
  assert.deepEqual(
    cap.options.map((o) => o.value),
    ["none", "minimal", "low", "medium", "high", "xhigh"],
  );
});

test("thinkingBudgetCapability constructor accepts provider-native modes", () => {
  const cap = thinkingBudgetCapability("supported", {
    modes: MINIMAX_THINKING_MODE_VALUES,
    defaultMode: "provider_default",
    supportsEnabled: true,
  });
  assert.equal(cap.kind, "thinking_budget");
  assert.equal(cap.control, "supported");
  assert.equal(cap.supportsEnabled, true);
  assert.equal(cap.defaultMode, "provider_default");
  assert.deepEqual(
    cap.modes?.map((m) => m.value),
    ["provider_default", "adaptive", "enabled", "disabled"],
  );
});

test("CHEAP_TIER_REASONING_EFFORT_VALUES does NOT include xhigh or minimal", () => {
  assert.ok(!CHEAP_TIER_REASONING_EFFORT_VALUES.includes("xhigh"));
  assert.ok(!CHEAP_TIER_REASONING_EFFORT_VALUES.includes("minimal"));
  assert.ok(CHEAP_TIER_REASONING_EFFORT_VALUES.includes("low"));
  assert.ok(CHEAP_TIER_REASONING_EFFORT_VALUES.includes("medium"));
  assert.ok(CHEAP_TIER_REASONING_EFFORT_VALUES.includes("high"));
  assert.ok(CHEAP_TIER_REASONING_EFFORT_VALUES.includes("none"));
});

test("FULL_REASONING_EFFORT_VALUES includes the full provider-native set", () => {
  for (const value of ["none", "minimal", "low", "medium", "high", "xhigh"]) {
    assert.ok(
      FULL_REASONING_EFFORT_VALUES.includes(value),
      `${value} must be in FULL_REASONING_EFFORT_VALUES`,
    );
  }
});

test("MINIMAX_THINKING_MODE_VALUES uses provider-native mode names", () => {
  assert.ok(MINIMAX_THINKING_MODE_VALUES.includes("provider_default"));
  assert.ok(MINIMAX_THINKING_MODE_VALUES.includes("adaptive"));
  assert.ok(MINIMAX_THINKING_MODE_VALUES.includes("enabled"));
  assert.ok(MINIMAX_THINKING_MODE_VALUES.includes("disabled"));
});

test("validateReasoningLevelForCapability rejects a value that was once valid but is no longer in the capability options", () => {
  // The brief: "If a saved reasoning option is no longer valid
  // for the selected model, omit it and fall back to provider
  // default." The access-control layer enforces the omit by
  // throwing ProviderAccessError when the value is no longer in
  // the capability's option set.
  const before = effortLevelsCapability(
    ["none", "minimal", "low", "medium", "high", "xhigh"],
    "supported",
  );
  // Provider drops `xhigh` and `minimal` in a future refresh.
  const after = effortLevelsCapability(["none", "low", "medium", "high"], "supported");
  // `xhigh` was valid before the refresh.
  assert.equal(isReasoningOptionValid(before, "xhigh"), true);
  // After the refresh, `xhigh` is stale and the chat route must
  // NOT send it. validateReasoningLevelForCapability throws.
  assert.throws(
    () => validateReasoningLevelForCapability("xhigh", after, "gpt-5.4-mini", "openai_api"),
    (err: unknown) =>
      err instanceof ProviderAccessError && /not supported/.test((err as Error).message),
  );
});
