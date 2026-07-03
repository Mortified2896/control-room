import assert from "node:assert/strict";
import test from "node:test";

import { GET } from "./route.ts";

/**
 * The API route always returns HTTP 200 with an array of provider
 * statuses. Each status encodes errors as `ok: false` with a clear
 * error object — the route must never leak secrets or 500 on
 * provider-level failures.
 */
test("subscription-usage route returns statuses array with minimax entry", async () => {
  const keyBefore = process.env.MINIMAX_SUBSCRIPTION_KEY;
  delete process.env.MINIMAX_SUBSCRIPTION_KEY;

  try {
    const response = await GET();
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(body.statuses));
    assert.ok(body.statuses.length >= 1);

    const minimax = body.statuses.find((s: { provider: string }) => s.provider === "minimax");
    assert.ok(minimax, "expected minimax status entry");
    assert.equal(minimax.ok, false);
    assert.equal(minimax.error?.code, "missing_minimax_subscription_key");
  } finally {
    if (keyBefore !== undefined) {
      process.env.MINIMAX_SUBSCRIPTION_KEY = keyBefore;
    }
  }
});

test("subscription-usage route response never contains secrets", async () => {
  const keyBefore = process.env.MINIMAX_SUBSCRIPTION_KEY;
  process.env.MINIMAX_SUBSCRIPTION_KEY = "test-secret-key-456";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        model_remains: [
          {
            model_name: "general",
            current_interval_total_count: 1000,
            current_interval_usage_count: 100,
            current_interval_remaining_percent: 90,
            current_interval_status: 0,
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const response = await GET();
    const body = await response.json();
    const json = JSON.stringify(body);

    assert.doesNotMatch(json, /Authorization/i);
    assert.doesNotMatch(json, /Bearer/i);
    assert.doesNotMatch(json, /test-secret-key/i);
    assert.doesNotMatch(json, /MINIMAX_SUBSCRIPTION_KEY/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (keyBefore !== undefined) {
      process.env.MINIMAX_SUBSCRIPTION_KEY = keyBefore;
    } else {
      delete process.env.MINIMAX_SUBSCRIPTION_KEY;
    }
  }
});

test("subscription-usage route returns ok:false without crashing on HTTP errors", async () => {
  const keyBefore = process.env.MINIMAX_SUBSCRIPTION_KEY;
  process.env.MINIMAX_SUBSCRIPTION_KEY = "some-key";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response("Unauthorized", { status: 401 });
  };

  try {
    const response = await GET();
    assert.equal(response.status, 200);

    const body = await response.json();
    const minimax = body.statuses.find((s: { provider: string }) => s.provider === "minimax");
    assert.ok(minimax);
    assert.equal(minimax.ok, false);
    assert.equal(minimax.error?.code, "minimax_http_401");
    assert.equal(minimax.error?.retryable, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (keyBefore !== undefined) {
      process.env.MINIMAX_SUBSCRIPTION_KEY = keyBefore;
    }
  }
});

test("subscription-usage route returns 200 with Cache-Control: no-store", async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});
