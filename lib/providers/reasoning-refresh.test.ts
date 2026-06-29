import test from "node:test";
import assert from "node:assert/strict";

import {
  fallbackCheapTierReasoningCapability,
  fallbackOpenAIReasoningCapability,
  refreshCodexReasoningCapability,
  refreshMiniMaxReasoningCapability,
  refreshOpenAIReasoningCapability,
} from "./reasoning-refresh";
import { effortLevelsCapability } from "./capability";

test("refreshOpenAIReasoningCapability returns the static metadata with refreshedAt", async () => {
  // Today the OpenAI provider does not expose per-model reasoning
  // option sets via `/v1/models`. The refresh path returns the
  // static metadata and stamps `refreshedAt` so the UI can show
  // "Last refreshed Xm ago".
  const staticCap = effortLevelsCapability(["none", "low", "medium", "high"], "supported", {
    defaultOption: "low",
    source: "static",
  });
  const result = await refreshOpenAIReasoningCapability("gpt-5.4-mini", staticCap);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.capability.kind, "effort_levels");
    if (result.capability.kind === "effort_levels") {
      assert.deepEqual(
        result.capability.options.map((o) => o.value),
        ["none", "low", "medium", "high"],
      );
      assert.ok(typeof result.capability.refreshedAt === "string");
      assert.match(result.capability.refreshedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    }
  }
});

test("refreshCodexReasoningCapability returns the static metadata with refreshedAt", async () => {
  const staticCap = effortLevelsCapability(
    ["none", "minimal", "low", "medium", "high", "xhigh"],
    "supported",
    { defaultOption: "low", source: "static" },
  );
  const result = await refreshCodexReasoningCapability("gpt-5.5", staticCap);
  assert.equal(result.ok, true);
  if (result.ok && result.capability.kind === "effort_levels") {
    assert.ok(typeof result.capability.refreshedAt === "string");
  }
});

test("refreshMiniMaxReasoningCapability returns the static metadata with refreshedAt", async () => {
  const staticCap = {
    kind: "thinking_budget" as const,
    control: "supported" as const,
    modes: [{ value: "provider_default" }, { value: "enabled" }, { value: "disabled" }],
    defaultMode: "provider_default",
    source: "static" as const,
  };
  const result = await refreshMiniMaxReasoningCapability("MiniMax-M3", staticCap);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.capability.kind, "thinking_budget");
    if (result.capability.kind === "thinking_budget") {
      assert.ok(typeof result.capability.refreshedAt === "string");
    }
  }
});

test("fallbackOpenAIReasoningCapability returns the full provider-native set", () => {
  // The fallback is the safe-conservative option set used when
  // the refresh path cannot discover richer options and the
  // caller has no static metadata.
  const cap = fallbackOpenAIReasoningCapability("unknown-model");
  assert.equal(cap.kind, "effort_levels");
  if (cap.kind === "effort_levels") {
    assert.deepEqual(
      cap.options.map((o) => o.value),
      ["none", "minimal", "low", "medium", "high", "xhigh"],
    );
    assert.equal(cap.source, "static");
  }
});

test("fallbackCheapTierReasoningCapability does NOT include xhigh or minimal", () => {
  // Cheap-tier fallback does not advertise `xhigh` or `minimal`
  // because those levels are not documented for the cheap tier.
  const cap = fallbackCheapTierReasoningCapability("gpt-5.4-mini");
  assert.equal(cap.kind, "effort_levels");
  if (cap.kind === "effort_levels") {
    const values = cap.options.map((o) => o.value);
    assert.ok(!values.includes("xhigh"));
    assert.ok(!values.includes("minimal"));
    assert.ok(values.includes("low"));
    assert.ok(values.includes("medium"));
    assert.ok(values.includes("high"));
    assert.ok(values.includes("none"));
  }
});
