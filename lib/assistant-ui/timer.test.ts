/**
 * timer.test.ts
 *
 * Unit tests for the timer/ETA helper functions used by CompactEstimateTimer
 * in components/assistant-ui/thread.tsx. These are pure functions with no
 * React dependencies, so they can be tested with Node.js's built-in test runner.
 *
 * Covered behaviors:
 * - formatEta: converts milliseconds to MM:SS string
 * - formatTimer: alias for formatEta
 * - formatSeconds: converts milliseconds to X.Xs string
 * - formatDeviation: formats latency/token deviation with sign and percentage
 */

import assert from "node:assert/strict";
import test from "node:test";

// Inline copies of the pure helpers so this file is self-contained and
// does not import from thread.tsx (which has React dependencies).
// Keep these in sync with the actual implementations in thread.tsx.

function formatEta(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatTimer(ms: number): string {
  return formatEta(ms);
}

function formatSeconds(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "—";
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDeviation(
  ms: number | null | undefined,
  pct: number | null | undefined,
): string {
  if (ms == null || pct == null) return "—";
  const sign = ms >= 0 ? "+" : "";
  return `${sign}${(ms / 1000).toFixed(1)}s / ${sign}${Math.round(pct)}%`;
}

// ---------------------------------------------------------------------------
// formatEta
// ---------------------------------------------------------------------------

test("formatEta formats zero as 00:00", () => {
  assert.equal(formatEta(0), "00:00");
});

test("formatEta formats exact seconds", () => {
  assert.equal(formatEta(1000), "00:01");
  assert.equal(formatEta(59_000), "00:59");
});

test("formatEta handles single-digit and double-digit minutes", () => {
  assert.equal(formatEta(60_000), "01:00");
  assert.equal(formatEta(119_000), "01:59");
  assert.equal(formatEta(599_000), "09:59");
  assert.equal(formatEta(600_000), "10:00");
  assert.equal(formatEta(3_660_000), "61:00");
});

test("formatEta rounds up fractional seconds", () => {
  // 2.3s → 3s
  assert.equal(formatEta(2300), "00:03");
  // 99.9s → 100s
  assert.equal(formatEta(99_900), "01:40");
});

test("formatEta clamps negative values to 00:00", () => {
  assert.equal(formatEta(-1000), "00:00");
  assert.equal(formatEta(-1_000_000), "00:00");
});

test("formatEta handles large values", () => {
  assert.equal(formatEta(3_600_000), "60:00"); // 1 hour
  // 86_400_000 ms = 86_400 s = 1440 min → "1440:00" (no hour cap)
  assert.equal(formatEta(86_400_000), "1440:00");
});

// ---------------------------------------------------------------------------
// formatTimer (alias for formatEta)
// ---------------------------------------------------------------------------

test("formatTimer is an alias for formatEta", () => {
  assert.equal(formatTimer(0), "00:00");
  assert.equal(formatTimer(90_000), "01:30");
  assert.equal(formatTimer(3661_000), "61:01");
});

// ---------------------------------------------------------------------------
// formatSeconds
// ---------------------------------------------------------------------------

test("formatSeconds formats non-null values", () => {
  assert.equal(formatSeconds(0), "0.0s");
  assert.equal(formatSeconds(500), "0.5s");
  assert.equal(formatSeconds(1000), "1.0s");
  assert.equal(formatSeconds(1500), "1.5s");
  assert.equal(formatSeconds(10_000), "10.0s");
  assert.equal(formatSeconds(12_345), "12.3s");
});

test("formatSeconds formats null / undefined as em-dash", () => {
  assert.equal(formatSeconds(null), "—");
  assert.equal(formatSeconds(undefined), "—");
  // NaN is a number so it passes the != null check; guard it explicitly.
  assert.equal(formatSeconds(NaN), "—");
});

// ---------------------------------------------------------------------------
// formatDeviation
// ---------------------------------------------------------------------------

test("formatDeviation formats positive deviations", () => {
  assert.equal(formatDeviation(500, 10), "+0.5s / +10%");
  assert.equal(formatDeviation(1_800, 36), "+1.8s / +36%");
});

test("formatDeviation formats negative deviations", () => {
  assert.equal(formatDeviation(-500, -10), "-0.5s / -10%");
  assert.equal(formatDeviation(-1800, -36), "-1.8s / -36%");
});

test("formatDeviation formats zero", () => {
  assert.equal(formatDeviation(0, 0), "+0.0s / +0%");
});

test("formatDeviation rounds percentages", () => {
  assert.equal(formatDeviation(500, 9.6), "+0.5s / +10%");
  assert.equal(formatDeviation(500, 9.4), "+0.5s / +9%");
});

test("formatDeviation returns em-dash for null values", () => {
  assert.equal(formatDeviation(null, 10), "—");
  assert.equal(formatDeviation(500, null), "—");
  assert.equal(formatDeviation(null, null), "—");
});
