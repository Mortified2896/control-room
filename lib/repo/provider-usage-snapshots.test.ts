import { test } from "node:test";
import assert from "node:assert/strict";
import { isDbConfigured } from "@/lib/db";
import {
  __resetSnapshotsForTests,
  insertSnapshot,
  latestSnapshotByProvider,
  latestSnapshotMap,
  listSnapshots,
  parseSnapshotRow,
  type SnapshotWriteInput,
} from "./provider-usage-snapshots";
import { EMPTY_CANDIDATE, type ProviderUsageSnapshot } from "@/lib/usage/snapshot-shape";

const MINIMAX_BASE: SnapshotWriteInput = {
  providerId: "minimax",
  providerLabel: "MiniMax subscription",
  accessType: "subscription",
  sourceType: "manual_screenshot",
  confidence: "observed",
  planName: "Token Plan · Monthly Plus",
  shortWindowLabel: "5h limit",
  shortWindowUsedPercent: 1,
  shortWindowRemainingPercent: 99,
  shortWindowResetLabel: "resets in 4 hr 44 min",
  weeklyWindowLabel: "Weekly limit",
  weeklyWindowUsedPercent: 81,
  weeklyWindowRemainingPercent: 19,
  weeklyWindowResetLabel: "resets in 3 days 8 hr",
  creditsRemaining: null,
  usageAtTimestampValue: "158.09M",
  usageAtTimestampLabel: "02 Jul 15:00 UTC",
  last7DaysUsage: "1.61B",
  last30DaysUsage: "3.31B",
  estimatedInputTokens: null,
  estimatedOutputTokens: null,
  estimatedTotalTokens: null,
  configuredLimitTokens: null,
  estimatedRemainingTokens: null,
  notes: "manual update from screenshot",
  screenshotAttachmentId: null,
};

const CODEX_BASE: SnapshotWriteInput = {
  ...MINIMAX_BASE,
  providerId: "codex",
  providerLabel: "Codex subscription",
  planName: null,
  shortWindowLabel: "5 hour usage limit",
  shortWindowUsedPercent: 15,
  shortWindowRemainingPercent: 85,
  shortWindowResetLabel: "Resets 8:05 PM",
  weeklyWindowLabel: "Weekly usage limit",
  weeklyWindowUsedPercent: 94,
  weeklyWindowRemainingPercent: 6,
  weeklyWindowResetLabel: "Resets Jul 7, 2026 10:48 AM",
  creditsRemaining: 0,
  usageAtTimestampValue: null,
  usageAtTimestampLabel: null,
  last7DaysUsage: null,
  last30DaysUsage: null,
  notes: null,
};

test("parseSnapshotRow — round-trips a MiniMax candidate", () => {
  const parsed = parseSnapshotRow({
    id: "00000000-0000-0000-0000-000000000001",
    provider_id: "minimax",
    provider_label: "MiniMax subscription",
    access_type: "subscription",
    source_type: "manual_screenshot",
    confidence: "observed",
    plan_name: "Token Plan · Monthly Plus",
    short_window_label: "5h limit",
    short_window_used_percent: 1,
    short_window_remaining_percent: 99,
    short_window_reset_label: "resets in 4 hr 44 min",
    weekly_window_label: "Weekly limit",
    weekly_window_used_percent: 81,
    weekly_window_remaining_percent: 19,
    weekly_window_reset_label: "resets in 3 days 8 hr",
    credits_remaining: null,
    usage_at_timestamp_value: "158.09M",
    usage_at_timestamp_label: "02 Jul 15:00 UTC",
    last_7_days_usage: "1.61B",
    last_30_days_usage: "3.31B",
    estimated_input_tokens: null,
    estimated_output_tokens: null,
    estimated_total_tokens: null,
    configured_limit_tokens: null,
    estimated_remaining_tokens: null,
    captured_at: new Date("2026-07-02T15:00:00Z"),
    notes: null,
    screenshot_attachment_id: null,
    created_at: new Date("2026-07-02T15:00:00Z"),
    updated_at: new Date("2026-07-02T15:00:00Z"),
  });
  assert.equal(parsed.providerId, "minimax");
  assert.equal(parsed.shortWindowUsedPercent, 1);
  assert.equal(parsed.shortWindowRemainingPercent, 99);
  assert.equal(parsed.weeklyWindowRemainingPercent, 19);
  assert.equal(parsed.last7DaysUsage, "1.61B");
  assert.equal(parsed.capturedAt, "2026-07-02T15:00:00.000Z");
});

test("parseSnapshotRow — accepts numeric strings from pg", () => {
  const parsed = parseSnapshotRow({
    id: "x",
    provider_id: "codex",
    provider_label: "Codex subscription",
    access_type: "subscription",
    source_type: "manual_screenshot",
    confidence: "observed",
    plan_name: null,
    short_window_label: null,
    short_window_used_percent: "15",
    short_window_remaining_percent: "85",
    short_window_reset_label: null,
    weekly_window_label: null,
    weekly_window_used_percent: "94",
    weekly_window_remaining_percent: "6",
    weekly_window_reset_label: null,
    credits_remaining: "0",
    usage_at_timestamp_value: null,
    usage_at_timestamp_label: null,
    last_7_days_usage: null,
    last_30_days_usage: null,
    estimated_input_tokens: null,
    estimated_output_tokens: null,
    estimated_total_tokens: null,
    configured_limit_tokens: null,
    estimated_remaining_tokens: null,
    captured_at: new Date(),
    notes: null,
    screenshot_attachment_id: null,
    created_at: new Date(),
    updated_at: new Date(),
  });
  assert.equal(parsed.creditsRemaining, 0);
  assert.equal(parsed.shortWindowRemainingPercent, 85);
});

test("listSnapshots — returns empty array on missing DB", async () => {
  if (isDbConfigured()) {
    // Skip when DB is configured; covered by integration test below.
    return;
  }
  const rows = await listSnapshots({ providerId: "minimax", limit: 10 });
  assert.deepEqual(rows, []);
});

test("latestSnapshotByProvider — returns null on missing DB", async () => {
  if (isDbConfigured()) return;
  const row = await latestSnapshotByProvider("minimax");
  assert.equal(row, null);
});

test("latestSnapshotMap — returns nulls for missing DB", async () => {
  if (isDbConfigured()) return;
  const map = await latestSnapshotMap(["minimax", "codex"]);
  assert.equal(map.minimax, null);
  assert.equal(map.codex, null);
});

// Integration tests — only run when DB is configured. They exercise
// the migration end-to-end so a future schema drift would be caught
// by `npm test`.
test("integration — insert + latestSnapshotByProvider + listSnapshots", async (t) => {
  if (!isDbConfigured()) {
    t.skip("DB not configured; integration test skipped");
    return;
  }
  try {
    await __resetSnapshotsForTests();
    const minimax = await insertSnapshot({
      ...MINIMAX_BASE,
      capturedAt: "2026-07-02T15:00:00.000Z",
    });
    assert.equal(minimax.providerId, "minimax");
    assert.ok(minimax.id !== null && typeof minimax.id === "string" && minimax.id.length > 0);

    const codex = await insertSnapshot({
      ...CODEX_BASE,
      capturedAt: "2026-07-02T15:30:00.000Z",
    });
    assert.equal(codex.providerId, "codex");

    const latestMinimax = await latestSnapshotByProvider("minimax");
    assert.ok(latestMinimax);
    assert.equal(latestMinimax?.id, minimax.id);

    const map = await latestSnapshotMap(["minimax", "codex"]);
    assert.equal(map.minimax?.id, minimax.id);
    assert.equal(map.codex?.id, codex.id);

    const all = await listSnapshots({ limit: 10 });
    assert.equal(all.length, 2);
  } finally {
    await __resetSnapshotsForTests();
  }
});

test("integration — listSnapshots with providerId filter", async (t) => {
  if (!isDbConfigured()) {
    t.skip("DB not configured; integration test skipped");
    return;
  }
  try {
    await __resetSnapshotsForTests();
    await insertSnapshot(MINIMAX_BASE);
    await insertSnapshot(MINIMAX_BASE);
    await insertSnapshot(CODEX_BASE);

    const minimaxOnly = await listSnapshots({ providerId: "minimax" });
    assert.equal(minimaxOnly.length, 2);
    assert.ok(minimaxOnly.every((r) => r.providerId === "minimax"));

    const all = await listSnapshots({ limit: 50 });
    assert.equal(all.length, 3);
  } finally {
    await __resetSnapshotsForTests();
  }
});

// Cross-check the canonical candidate from snapshot-shape.ts has the
// expected shape so a future refactor that drops a field is caught.
test("EMPTY_CANDIDATE has expected defaults", () => {
  const c: ProviderUsageSnapshot = EMPTY_CANDIDATE;
  assert.equal(c.providerId, "minimax");
  assert.equal(c.accessType, "subscription");
  assert.equal(c.sourceType, "manual_screenshot");
  assert.equal(c.confidence, "unknown");
  assert.equal(c.shortWindowUsedPercent, null);
  assert.equal(c.shortWindowRemainingPercent, null);
});
