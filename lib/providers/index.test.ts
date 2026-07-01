import test from "node:test";
import assert from "node:assert/strict";

import { resolveModel } from "./index";

test("resolveModel treats codex:gpt-5.5 as subscription-backed", () => {
  const resolved = resolveModel("codex:gpt-5.5");
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.resolved.providerId, "codex");
    assert.equal(resolved.resolved.modelId, "codex:gpt-5.5");
    assert.equal(resolved.resolved.billingSource, "subscription");
  }
});

test("resolveModel does not advertise legacy codex:gpt-5.5-small", () => {
  const resolved = resolveModel("codex:gpt-5.5-small");
  assert.equal(resolved.ok, false);
  if (!resolved.ok) assert.equal(resolved.error.kind, "unknown_model");
});
