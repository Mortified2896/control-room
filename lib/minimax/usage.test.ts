import assert from "node:assert/strict";
import test from "node:test";

import { parseMiniMaxQuotaJson } from "./usage.ts";

test("MiniMax quota parser preserves percentages without inventing tokens", () => {
  const usage = parseMiniMaxQuotaJson(
    JSON.stringify({
      modelRemains: [
        {
          modelName: "MiniMax-M3",
          currentIntervalRemainingPercent: 42,
          currentWeeklyRemainingPercent: "75",
        },
      ],
    }),
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(usage.status, "available");
  assert.equal(usage.remainingTokens, null);
  assert.deepEqual(usage.modelRemains, [
    {
      modelName: "MiniMax-M3",
      currentIntervalRemainingPercent: 42,
      currentWeeklyRemainingPercent: 75,
    },
  ]);
});

test("MiniMax quota parser returns safe error for invalid JSON", () => {
  const usage = parseMiniMaxQuotaJson("not json", "2026-01-01T00:00:00.000Z");
  assert.equal(usage.status, "error");
  assert.equal(usage.source, "unknown");
  assert.ok(usage.error?.message);
});
