import test from "node:test";
import assert from "node:assert/strict";

import { getRuntimeProviderOptions } from "./runtime";
import {
  effortLevelsCapability,
  MINIMAX_THINKING_MODE_VALUES,
  noReasoningCapability,
  thinkingBudgetCapability,
  UNKNOWN_REASONING_CAPABILITY,
} from "./capability";

const OPENAI_RESOLVED = {
  providerId: "openai" as const,
  modelId: "gpt-5.4-mini",
  billingSource: "api_billing" as const,
};
const MINIMAX_RESOLVED = {
  providerId: "minimax" as const,
  modelId: "MiniMax-M3",
  billingSource: "subscription" as const,
};

test("OpenAI + effort_levels + supported emits reasoningEffort", () => {
  const cap = effortLevelsCapability(["low", "medium"], "supported");
  const opts = getRuntimeProviderOptions({
    resolved: OPENAI_RESOLVED,
    capability: cap,
    reasoningOption: "medium",
  });
  assert.deepEqual(opts, { openai: { reasoningEffort: "medium" } });
});

test("OpenAI + effort_levels + model_dependent emits reasoningEffort", () => {
  const cap = effortLevelsCapability(["low"], "model_dependent");
  const opts = getRuntimeProviderOptions({
    resolved: OPENAI_RESOLVED,
    capability: cap,
    reasoningOption: "high",
  });
  // Model-dependent: trust the underlying provider — ship the user's
  // pick through.
  assert.deepEqual(opts, { openai: { reasoningEffort: "high" } });
});

test("OpenAI + effort_levels + unknown omits provider options (no fake reasoningEffort)", () => {
  const cap = effortLevelsCapability([], "unknown");
  const opts = getRuntimeProviderOptions({
    resolved: OPENAI_RESOLVED,
    capability: cap,
    reasoningOption: "low",
  });
  assert.equal(opts, undefined);
});

test("OpenAI + thinking_budget omits provider options (no fake reasoningEffort)", () => {
  // OpenAI does not advertise a thinking-budget capability today,
  // but if a model id does, the runtime must NOT fall back to
  // `reasoningEffort`.
  const cap = thinkingBudgetCapability("supported");
  const opts = getRuntimeProviderOptions({
    resolved: OPENAI_RESOLVED,
    capability: cap,
    reasoningOption: "low",
    thinkingMode: "enabled",
  });
  assert.equal(opts, undefined);
});

test("OpenAI + none / unknown capability omits provider options", () => {
  for (const cap of [noReasoningCapability(), UNKNOWN_REASONING_CAPABILITY]) {
    const opts = getRuntimeProviderOptions({
      resolved: OPENAI_RESOLVED,
      capability: cap,
      reasoningOption: "low",
    });
    assert.equal(opts, undefined);
  }
});

test("MiniMax + thinking_budget + supported + thinkingMode=enabled emits reasoning.enabled=true", () => {
  const cap = thinkingBudgetCapability("supported", { supportsEnabled: true });
  const opts = getRuntimeProviderOptions({
    resolved: MINIMAX_RESOLVED,
    capability: cap,
    reasoningOption: "low",
    thinkingMode: "enabled",
  });
  assert.deepEqual(opts, { minimax: { reasoning: { enabled: true } } });
});

test("MiniMax + thinking_budget + supported + thinkingMode=disabled emits reasoning.enabled=false", () => {
  const cap = thinkingBudgetCapability("supported", { supportsEnabled: true });
  const opts = getRuntimeProviderOptions({
    resolved: MINIMAX_RESOLVED,
    capability: cap,
    reasoningOption: "low",
    thinkingMode: "disabled",
  });
  assert.deepEqual(opts, { minimax: { reasoning: { enabled: false } } });
});

test("MiniMax + thinking_budget + supported + thinkingMode=provider_default omits options", () => {
  // Default mode means "let the provider pick" — we do NOT pass a
  // reasoning payload at all.
  const cap = thinkingBudgetCapability("supported", { supportsEnabled: true });
  const opts = getRuntimeProviderOptions({
    resolved: MINIMAX_RESOLVED,
    capability: cap,
    reasoningOption: "low",
    thinkingMode: "provider_default",
  });
  assert.equal(opts, undefined);
});

test("MiniMax + thinking_budget + model_dependent omits options (no fake enabled)", () => {
  const cap = thinkingBudgetCapability("model_dependent");
  const opts = getRuntimeProviderOptions({
    resolved: MINIMAX_RESOLVED,
    capability: cap,
    reasoningOption: "low",
    thinkingMode: "enabled",
  });
  assert.equal(opts, undefined);
});

test("MiniMax + thinking_budget + unknown omits options (no fake enabled)", () => {
  const cap = thinkingBudgetCapability("unknown");
  const opts = getRuntimeProviderOptions({
    resolved: MINIMAX_RESOLVED,
    capability: cap,
    reasoningOption: "low",
    thinkingMode: "enabled",
  });
  assert.equal(opts, undefined);
});

test("MiniMax + effort_levels + supported omits options (no fake MiniMax payload)", () => {
  // MiniMax does not expose OpenAI-style effort levels; if a model
  // id is misconfigured with an effort_levels capability, the runtime
  // must not invent a MiniMax reasoning payload.
  const cap = effortLevelsCapability(["low", "medium"], "supported");
  const opts = getRuntimeProviderOptions({
    resolved: MINIMAX_RESOLVED,
    capability: cap,
    reasoningOption: "low",
  });
  assert.equal(opts, undefined);
});

test("OpenAI + effort_levels + supported passes provider-native value verbatim", () => {
  // The runtime adapter forwards the exact provider-native value
  // to the provider. We do NOT remap `xhigh` to `high` or hide
  // `none` / `minimal` — every advertised value flows through.
  const full = effortLevelsCapability(
    ["none", "minimal", "low", "medium", "high", "xhigh"],
    "supported",
  );
  for (const value of ["none", "minimal", "low", "medium", "high", "xhigh"]) {
    const opts = getRuntimeProviderOptions({
      resolved: OPENAI_RESOLVED,
      capability: full,
      reasoningOption: value,
    });
    assert.deepEqual(opts, { openai: { reasoningEffort: value } });
  }
});

test("MiniMax + thinking_budget + supported + provider-native mode 'adaptive' omits options", () => {
  // MiniMax `adaptive` (and any future non-`enabled`/`disabled`
  // mode) is advertised as a thinking mode but the runtime cannot
  // yet translate it into the MiniMax wire shape. The runtime
  // omits the payload rather than inventing one — the provider
  // defaults remain in effect.
  const cap = thinkingBudgetCapability("supported", {
    modes: [...MINIMAX_THINKING_MODE_VALUES],
    supportsEnabled: true,
  });
  const opts = getRuntimeProviderOptions({
    resolved: MINIMAX_RESOLVED,
    capability: cap,
    reasoningOption: "low",
    thinkingMode: "adaptive",
  });
  assert.equal(opts, undefined);
});

test("MiniMax + thinking_budget + unknown / model_dependent omits provider options", () => {
  // When we don't trust the user pick (control !== "supported"),
  // the runtime must NOT silently override the provider default.
  for (const control of ["unknown", "model_dependent"] as const) {
    const cap = thinkingBudgetCapability(control);
    for (const mode of ["enabled", "disabled", "provider_default", "adaptive"]) {
      const opts = getRuntimeProviderOptions({
        resolved: MINIMAX_RESOLVED,
        capability: cap,
        reasoningOption: "low",
        thinkingMode: mode,
      });
      assert.equal(
        opts,
        undefined,
        `thinking_budget + ${control} + ${mode} must not emit provider options`,
      );
    }
  }
});

test("OpenAI forwards `none`, `minimal`, `xhigh` verbatim to the provider", () => {
  // Regression for the brief: the request payload must use the
  // exact provider-native value, not a translated low/medium/high
  // triple. We do NOT narrow to a fixed enum — Codex `xhigh`,
  // OpenAI `none`, and OpenAI `minimal` flow through unchanged.
  const cap = effortLevelsCapability(
    ["none", "minimal", "low", "medium", "high", "xhigh"],
    "supported",
  );
  const cases: Array<{ value: string; description: string }> = [
    { value: "none", description: "OpenAI 'no reasoning' effort" },
    { value: "minimal", description: "OpenAI 'minimal' effort (non-legacy)" },
    { value: "xhigh", description: "OpenAI 'xhigh' effort (non-legacy)" },
    { value: "low", description: "OpenAI 'low' effort (legacy)" },
    { value: "medium", description: "OpenAI 'medium' effort (legacy)" },
    { value: "high", description: "OpenAI 'high' effort (legacy)" },
  ];
  for (const { value, description } of cases) {
    const opts = getRuntimeProviderOptions({
      resolved: OPENAI_RESOLVED,
      capability: cap,
      reasoningOption: value,
    });
    assert.deepEqual(
      opts,
      { openai: { reasoningEffort: value } },
      `${description} (${value}) must pass through verbatim`,
    );
  }
});

test("MiniMax M3 `provider_default` omits the reasoning payload", () => {
  // The runtime adapter treats `provider_default` as "let the
  // provider decide" and omits the reasoning block entirely —
  // we never send a fake `{ reasoning: { enabled: ... } }`.
  const cap = thinkingBudgetCapability("supported", {
    modes: MINIMAX_THINKING_MODE_VALUES,
    supportsEnabled: true,
  });
  const opts = getRuntimeProviderOptions({
    resolved: MINIMAX_RESOLVED,
    capability: cap,
    reasoningOption: "low",
    thinkingMode: "provider_default",
  });
  assert.equal(opts, undefined);
});

test("MiniMax M3 `enabled` / `disabled` / `adaptive` / `provider_default` all flow through correctly", () => {
  // The four MiniMax M3 modes the catalog advertises. Each
  // value the runtime knows about (`enabled` / `disabled`)
  // translates to the MiniMax wire shape; `adaptive` and
  // `provider_default` omit the block so the provider uses its
  // own default.
  const cap = thinkingBudgetCapability("supported", {
    modes: MINIMAX_THINKING_MODE_VALUES,
    supportsEnabled: true,
  });
  const cases: Array<{ mode: string; expected: unknown }> = [
    { mode: "provider_default", expected: undefined },
    { mode: "adaptive", expected: undefined },
    { mode: "enabled", expected: { minimax: { reasoning: { enabled: true } } } },
    { mode: "disabled", expected: { minimax: { reasoning: { enabled: false } } } },
  ];
  for (const { mode, expected } of cases) {
    const opts = getRuntimeProviderOptions({
      resolved: MINIMAX_RESOLVED,
      capability: cap,
      reasoningOption: "low",
      thinkingMode: mode,
    });
    assert.deepEqual(
      opts,
      expected,
      `MiniMax M3 mode '${mode}' must produce the expected runtime options`,
    );
  }
});
