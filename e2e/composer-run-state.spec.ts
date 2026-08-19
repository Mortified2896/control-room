/**
 * composer-run-state.spec.ts
 *
 * Targeted Playwright tests for two regressions in the chat composer:
 * 1. The composer input must be locked (disabled) while a prompt is running.
 *    The user must NOT be able to mutate the in-flight submitted prompt.
 * 2. The countdown / expected-time indicator must stop immediately when the
 *    assistant message completes (or errors / cancels).
 *
 * These are isolated UI-behavior tests using mocked API responses so they
 * do NOT require a real LLM call.
 */

import { test, expect, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a complete SSE response string for /api/chat that includes:
 *   - a router-execution-estimate data part (starts the countdown timer)
 *   - a router-execution-outcome data part (stops the countdown timer)
 *   - streamed assistant text
 *   - a done event
 *
 * Playwright's route.fulfill() requires a string | Buffer body, so we
 * pre-build the entire SSE stream as a string rather than using a
 * ReadableStream (which is not assignable to the fulfill body type).
 */
function buildStreamingChatResponse(opts?: {
  /** Milliseconds for the estimate. Default 5000. */
  estimateMs?: number;
  /** Milliseconds for the simulated latency. Default 300. */
  latencyMs?: number;
  /** Custom outcome data. Omit for default "faster" outcome. */
  outcomeMs?: number;
}): string {
  const estimateMs = opts?.estimateMs ?? 5000;
  const outcomeMs = opts?.outcomeMs ?? 3200;
  const startedAt = new Date().toISOString();
  const lines: string[] = [];

  // Estimate data part — starts the countdown timer.
  lines.push(
    `event: custom`,
    `data: ${JSON.stringify({
      type: "data",
      name: "router-execution-estimate",
      data: {
        runId: "test-run-1",
        expected_execution_latency_ms: estimateMs,
        upper_execution_latency_ms: estimateMs * 3,
        estimate_quality: "rough",
        started_at: startedAt,
      },
    })}`,
    ``,
  );

  // Stream the assistant text in small chunks.
  const text = "This is a fake streamed response.";
  for (let i = 0; i <= text.length; i++) {
    const char = i < text.length ? text[i] : "";
    lines.push(
      `event: custom`,
      `data: ${JSON.stringify({ type: "text-delta", textDelta: char })}`,
      ``,
    );
  }

  // Outcome data part — stops the countdown timer.
  const deviationMs = outcomeMs - estimateMs;
  const deviationPct = Math.round((deviationMs / estimateMs) * 100);
  lines.push(
    `event: custom`,
    `data: ${JSON.stringify({
      type: "data",
      name: "router-execution-outcome",
      data: {
        runId: "test-run-1",
        actual_execution_latency_ms: outcomeMs,
        actual_input_tokens: 20,
        actual_output_tokens: text.length,
        actual_total_tokens: 20 + text.length,
        latency_deviation_ms: deviationMs,
        latency_deviation_pct: deviationPct,
        token_deviation_count: 0,
        token_deviation_pct: 0,
        latency_result: deviationMs < 0 ? "faster" : deviationMs > 0 ? "slower" : "on-target",
        token_result: "on-target",
      },
    })}`,
    ``,
  );

  // Done event.
  lines.push(`event: done`, `data: ${JSON.stringify({ finishReason: "stop" })}`, ``);

  return lines.join("\n");
}

/**
 * Mock /api/chat with a pre-built SSE string.
 * The pre-built string approach is required because Playwright's
 * route.fulfill() body must be string | Buffer, not ReadableStream.
 */
function mockChatResponse(page: Page, body: string) {
  page.route("**/api/chat", (route) => {
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "x-test-stream": "true", "cache-control": "no-store" },
      body,
    });
  });
}

// ---------------------------------------------------------------------------
// Test: composer is locked during active run
// ---------------------------------------------------------------------------

test("Composer input is disabled while a prompt is running", async ({ page }) => {
  // Mock /api/chat with a response that starts but never finishes.
  // We send the estimate data part (which triggers the timer) but never
  // send the outcome or done event, leaving the run in a "running" state.
  const hangingBody = [
    `event: custom`,
    `data: ${JSON.stringify({
      type: "data",
      name: "router-execution-estimate",
      data: {
        runId: "test-run-hang",
        expected_execution_latency_ms: 3000,
        upper_execution_latency_ms: 10000,
        estimate_quality: "rough",
        started_at: new Date().toISOString(),
      },
    })}`,
    ``,
    // NO done event — the stream hangs, keeping the run "running".
  ].join("\n");

  mockChatResponse(page, hangingBody);

  await page.goto("/");
  await expect(page.locator('textarea[aria-label*="Message input"]')).toBeVisible({
    timeout: 30_000,
  });

  // Submit a prompt.
  const composer = page.locator('textarea[aria-label*="Message input"]');
  await composer.fill("Hello, test message");
  await composer.press("Enter");

  // Give the UI time to process the streaming start and update isRunning.
  await page.waitForTimeout(1000);

  // The composer input must be disabled during the running prompt.
  const isDisabled = await composer.isDisabled();
  expect(
    isDisabled,
    "Composer input must be disabled while a prompt is running to prevent accidental mutation of the in-flight submitted text",
  ).toBe(true);

  // Verify the user cannot type into the disabled composer.
  await composer.click({ force: true }); // force past the disabled click guard
  await page.keyboard.type("extra text");
  const value = await composer.inputValue();
  expect(
    value,
    "Disabled composer must not accept new keystrokes — the submitted prompt must remain stable",
  ).toBe("Hello, test message");
});

// ---------------------------------------------------------------------------
// Test: countdown stops when assistant message completes
// ---------------------------------------------------------------------------

test("Countdown / ETA timer stops when assistant message completes", async ({ page }) => {
  const body = buildStreamingChatResponse();
  mockChatResponse(page, body);

  await page.goto("/");
  await expect(page.locator('textarea[aria-label*="Message input"]')).toBeVisible({
    timeout: 30_000,
  });

  const composer = page.locator('textarea[aria-label*="Message input"]');
  await composer.fill("Hello, timer test");
  await composer.press("Enter");

  // The timer should appear (estimate data part was injected).
  // Look for the elapsed time format that CompactEstimateTimer renders.
  const timer = page.locator("text=/elapsed \\d+:\\d+").first();
  await expect(timer).toBeVisible({ timeout: 10_000 });

  // Capture the elapsed value while the stream is still active.
  const textBefore = (await timer.textContent()) ?? "";
  const elapsedMatchBefore = textBefore.match(/elapsed (\d+:\d+)/);
  expect(
    elapsedMatchBefore,
    `Timer should show an elapsed time. Got: ${textBefore}`,
  ).toBeTruthy();
  const elapsedBefore = elapsedMatchBefore![1];

  // Wait 2 seconds. The stream should have completed by now
  // (the outcome data part was injected before the done event).
  // If the fix is working, the elapsed time must NOT advance.
  await page.waitForTimeout(2000);
  const textAfter = (await timer.textContent()) ?? "";
  const elapsedMatchAfter = textAfter.match(/elapsed (\d+:\d+)/);

  expect(
    elapsedMatchAfter,
    `Timer should still be visible (frozen elapsed). Got: ${textAfter}`,
  ).toBeTruthy();
  const elapsedAfter = elapsedMatchAfter![1];

  expect(
    elapsedBefore,
    `Timer elapsed value must not advance after completion. Before: ${textBefore}, After: ${textAfter}`,
  ).toBe(elapsedAfter);
});

// ---------------------------------------------------------------------------
// Test: timer does not leave stale intervals after thread switch
// ---------------------------------------------------------------------------

test("No stale timer intervals visible after switching threads", async ({ page }) => {
  // This test verifies the fix for a memory-leak scenario where the
  // CompactEstimateTimer interval was not cleaned up when a thread
  // was switched away. The interval would keep running in the background,
  // and if the component re-mounted (e.g., after a scroll), multiple
  // stale intervals would accumulate.
  //
  // The fix adds a runEnd event handler that stops the interval immediately.
  // This test checks that the timer state is properly isolated per-thread
  // by verifying no timers from a hanging thread-1 appear on thread-2.

  const hangingBody = [
    `event: custom`,
    `data: ${JSON.stringify({
      type: "data",
      name: "router-execution-estimate",
      data: {
        runId: "stale-test",
        expected_execution_latency_ms: 30000,
        upper_execution_latency_ms: 60000,
        estimate_quality: "rough",
        started_at: new Date().toISOString(),
      },
    })}`,
    ``,
    // No done event — the stream hangs, keeping the run active on thread-1.
  ].join("\n");

  mockChatResponse(page, hangingBody);

  await page.goto("/");
  await expect(page.locator('textarea[aria-label*="Message input"]')).toBeVisible({
    timeout: 30_000,
  });

  // Submit a prompt on thread-1 (the initial thread).
  const composer = page.locator('textarea[aria-label*="Message input"]');
  await composer.fill("Message on thread 1");
  await composer.press("Enter");

  // The timer should appear on thread-1.
  const timer = page.locator("text=/elapsed \\d+:\\d+").first();
  await expect(timer).toBeVisible({ timeout: 5000 });

  // Attempt to switch to a new thread via the sidebar "New chat" button.
  // The sidebar may or may not be present on all viewport sizes; try both
  // the sidebar button and the keyboard shortcut.
  const newChatBtn = page.getByTestId("sidebar-new-chat");
  if (await newChatBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await newChatBtn.click();
  } else {
    // Fall back to keyboard shortcut (n) to create a new thread.
    await page.keyboard.press("n");
    await page.waitForTimeout(500);
  }

  // On thread-2 (new chat), the composer should be visible and empty.
  const composerOnThread2 = page.locator('textarea[aria-label*="Message input"]');
  await expect(composerOnThread2).toBeVisible({ timeout: 5000 });
  await expect(composerOnThread2).toHaveValue("");

  // The timer from thread-1 must NOT appear on thread-2.
  // If the fix is correct, the interval was cleaned up when the thread
  // switched away (via the AssistantRuntimeProvider unmounting the old
  // thread's component tree).
  const timersOnThread2 = page.locator("text=/elapsed \\d+:\\d+");
  const count = await timersOnThread2.count();
  expect(
    count,
    `No stale timers from thread-1 should be visible on thread-2. Found ${count} timer(s).`,
  ).toBe(0);
});
