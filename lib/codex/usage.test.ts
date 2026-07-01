import assert from "node:assert/strict";
import test from "node:test";

import { codexUsageUnknown } from "./usage.ts";

test("Codex usage is explicitly unknown without invented quota", () => {
  const usage = codexUsageUnknown("2026-01-01T00:00:00.000Z");
  assert.equal(usage.provider, "codex_cli");
  assert.equal(usage.status, "unknown");
  assert.equal(usage.source, "codex_dashboard_unavailable");
  assert.equal(usage.fiveHourLimit, null);
  assert.equal(usage.weeklyLimit, null);
  assert.equal(usage.credits, null);
  assert.equal(usage.contextRemainingTokens, null);
});
