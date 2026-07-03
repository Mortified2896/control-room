import assert from "node:assert/strict";
import test from "node:test";

import {
  parseMiniMaxTokenPlanResponse,
  fetchMiniMaxSubscriptionUsage,
  getMiniMaxSubscriptionConfig,
  type SubscriptionUsageStatus,
} from "./subscription-usage.ts";

const CHECKED_AT = "2026-07-03T12:00:00.000Z";

test("MiniMax subscription parser returns available status with rolling + weekly summary", () => {
  const status = parseMiniMaxTokenPlanResponse(
    JSON.stringify({
      model_remains: [
        {
          model_name: "general",
          current_interval_total_count: 1_000_000,
          current_interval_usage_count: 350_000,
          current_interval_remaining_percent: 65,
          current_interval_status: 0,
          end_time: 1780934400000,
          current_weekly_total_count: 500_000,
          current_weekly_usage_count: 100_000,
          current_weekly_remaining_percent: 80,
          current_weekly_status: 0,
          weekly_end_time: 1781539200000,
        },
      ],
    }),
    CHECKED_AT,
  );

  assert.equal(status.provider, "minimax");
  assert.equal(status.ok, true);
  assert.equal(status.rawAvailable, true);
  assert.equal(status.error, undefined);
  assert.equal(status.summary?.length, 2);

  const intervalSummary = status.summary![0]!;
  assert.equal(intervalSummary.label, "general");
  assert.equal(intervalSummary.window, "rolling_interval");
  assert.equal(intervalSummary.limit, 1_000_000);
  assert.equal(intervalSummary.used, 350_000);
  assert.equal(intervalSummary.remaining, 650_000);
  assert.equal(intervalSummary.remainingPercent, 65);

  const weeklySummary = status.summary![1]!;
  assert.equal(weeklySummary.label, "general");
  assert.equal(weeklySummary.window, "weekly");
  assert.equal(weeklySummary.limit, 500_000);
  assert.equal(weeklySummary.used, 100_000);
  assert.equal(weeklySummary.remaining, 400_000);
  assert.equal(weeklySummary.remainingPercent, 80);
});

test("MiniMax subscription parser handles empty model_remains", () => {
  const status = parseMiniMaxTokenPlanResponse(
    JSON.stringify({ model_remains: [] }),
    CHECKED_AT,
  );

  assert.equal(status.ok, true);
  assert.equal(status.rawAvailable, false);
  assert.deepEqual(status.summary, []);
});

test("MiniMax subscription parser handles missing model_remains field", () => {
  const status = parseMiniMaxTokenPlanResponse(
    JSON.stringify({}),
    CHECKED_AT,
  );

  assert.equal(status.ok, true);
  assert.equal(status.rawAvailable, false);
  assert.deepEqual(status.summary, []);
});

test("MiniMax subscription parser handles base_resp error code", () => {
  const status = parseMiniMaxTokenPlanResponse(
    JSON.stringify({
      base_resp: {
        status_code: 1004,
        status_msg: "authentication failed",
      },
    }),
    CHECKED_AT,
  );

  assert.equal(status.ok, false);
  assert.equal(status.rawAvailable, false);
  assert.equal(status.error?.code, "minimax_token_plan_api_error");
  assert.equal(status.error?.message, "authentication failed");
  assert.equal(status.error?.retryable, false);
});

test("MiniMax subscription parser handles base_resp server error (MiniMax status code)", () => {
  const status = parseMiniMaxTokenPlanResponse(
    JSON.stringify({
      base_resp: {
        status_code: 5001,
        status_msg: "internal server error",
      },
    }),
    CHECKED_AT,
  );

  assert.equal(status.ok, false);
  assert.equal(status.error?.code, "minimax_token_plan_api_error");
  assert.equal(status.error?.retryable, false);
});

test("MiniMax subscription parser handles malformed JSON", () => {
  const status = parseMiniMaxTokenPlanResponse("not json", CHECKED_AT);

  assert.equal(status.ok, false);
  assert.equal(status.error?.code, "invalid_minimax_usage_response");
  assert.equal(status.error?.retryable, false);
});

test("MiniMax subscription parser handles null input", () => {
  const status = parseMiniMaxTokenPlanResponse("null", CHECKED_AT);

  assert.equal(status.ok, false);
  assert.equal(status.error?.code, "invalid_minimax_usage_response");
});

test("MiniMax subscription parser handles models not in plan (status 3)", () => {
  const status = parseMiniMaxTokenPlanResponse(
    JSON.stringify({
      model_remains: [
        {
          model_name: "video",
          current_interval_total_count: 0,
          current_interval_usage_count: 0,
          current_interval_remaining_percent: 100,
          current_interval_status: 3,
          current_weekly_total_count: 0,
          current_weekly_usage_count: 0,
          current_weekly_remaining_percent: 100,
          current_weekly_status: 3,
        },
      ],
    }),
    CHECKED_AT,
  );

  assert.equal(status.ok, true);
  assert.equal(status.rawAvailable, false);
  assert.equal(status.summary?.length, 1);
  assert.equal(status.summary![0]!.label, "video");
  assert.equal(status.summary![0]!.window, "not_in_plan");
});

test("MiniMax subscription fetcher returns missing key error when env is not set", async () => {
  const keyBefore = process.env.MINIMAX_SUBSCRIPTION_KEY;
  delete process.env.MINIMAX_SUBSCRIPTION_KEY;

  try {
    const status = await fetchMiniMaxSubscriptionUsage();

    assert.equal(status.provider, "minimax");
    assert.equal(status.ok, false);
    assert.equal(status.error?.code, "missing_minimax_subscription_key");
    assert.equal(status.error?.retryable, false);
    assert.ok(status.error?.message.includes("MINIMAX_SUBSCRIPTION_KEY"));
  } finally {
    if (keyBefore !== undefined) {
      process.env.MINIMAX_SUBSCRIPTION_KEY = keyBefore;
    }
  }
});

test("MiniMax subscription fetcher handles HTTP 401 from endpoint", async () => {
  const keyBefore = process.env.MINIMAX_SUBSCRIPTION_KEY;
  process.env.MINIMAX_SUBSCRIPTION_KEY = "test-key-123";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    return new Response(
      JSON.stringify({
        base_resp: { status_code: 1004, status_msg: "invalid key" },
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const status = await fetchMiniMaxSubscriptionUsage();

    assert.equal(status.ok, false);
    assert.equal(status.error?.code, "minimax_http_401");
    assert.equal(status.error?.retryable, false);
    assert.ok(status.error?.message.includes("invalid key"));
  } finally {
    globalThis.fetch = originalFetch;
    if (keyBefore !== undefined) {
      process.env.MINIMAX_SUBSCRIPTION_KEY = keyBefore;
    } else {
      delete process.env.MINIMAX_SUBSCRIPTION_KEY;
    }
  }
});

test("MiniMax subscription fetcher handles HTTP 500 from endpoint as retryable", async () => {
  const keyBefore = process.env.MINIMAX_SUBSCRIPTION_KEY;
  process.env.MINIMAX_SUBSCRIPTION_KEY = "test-key-123";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response("Internal Server Error", {
      status: 500,
    });
  };

  try {
    const status = await fetchMiniMaxSubscriptionUsage();

    assert.equal(status.ok, false);
    assert.equal(status.error?.code, "minimax_http_500");
    assert.equal(status.error?.retryable, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (keyBefore !== undefined) {
      process.env.MINIMAX_SUBSCRIPTION_KEY = keyBefore;
    } else {
      delete process.env.MINIMAX_SUBSCRIPTION_KEY;
    }
  }
});

test("MiniMax subscription fetcher handles network timeout", async () => {
  const keyBefore = process.env.MINIMAX_SUBSCRIPTION_KEY;
  process.env.MINIMAX_SUBSCRIPTION_KEY = "test-key-123";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal;
    return new Promise((_, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };

  try {
    const status = await fetchMiniMaxSubscriptionUsage();

    assert.equal(status.ok, false);
    assert.equal(status.error?.code, "minimax_subscription_timeout");
    assert.equal(status.error?.retryable, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (keyBefore !== undefined) {
      process.env.MINIMAX_SUBSCRIPTION_KEY = keyBefore;
    } else {
      delete process.env.MINIMAX_SUBSCRIPTION_KEY;
    }
  }
});

test("MiniMax subscription fetcher handles successful fetch from endpoint", async () => {
  const keyBefore = process.env.MINIMAX_SUBSCRIPTION_KEY;
  process.env.MINIMAX_SUBSCRIPTION_KEY = "test-key-123";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    assert.ok(String(input).includes("token_plan/remains"));
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers?.Authorization, "Bearer test-key-123");
    assert.equal(headers?.["Content-Type"], "application/json");

    return new Response(
      JSON.stringify({
        model_remains: [
          {
            model_name: "general",
            current_interval_total_count: 500_000,
            current_interval_usage_count: 50_000,
            current_interval_remaining_percent: 90,
            current_interval_status: 0,
            end_time: 1780934400000,
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const status = await fetchMiniMaxSubscriptionUsage();

    assert.equal(status.ok, true);
    assert.equal(status.provider, "minimax");
    assert.equal(status.rawAvailable, true);
    assert.equal(status.summary?.length, 1);
    assert.equal(status.summary![0]!.label, "general");
    assert.equal(status.summary![0]!.remainingPercent, 90);
    assert.equal(status.error, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (keyBefore !== undefined) {
      process.env.MINIMAX_SUBSCRIPTION_KEY = keyBefore;
    } else {
      delete process.env.MINIMAX_SUBSCRIPTION_KEY;
    }
  }
});

test("getMiniMaxSubscriptionConfig returns key when env is set", () => {
  const keyBefore = process.env.MINIMAX_SUBSCRIPTION_KEY;
  process.env.MINIMAX_SUBSCRIPTION_KEY = "my-key";

  try {
    const config = getMiniMaxSubscriptionConfig();
    assert.equal(config.keySet, true);
    assert.equal(config.key, "my-key");
    assert.ok(config.baseURL.includes("api.minimax.io"));
  } finally {
    if (keyBefore !== undefined) {
      process.env.MINIMAX_SUBSCRIPTION_KEY = keyBefore;
    } else {
      delete process.env.MINIMAX_SUBSCRIPTION_KEY;
    }
  }
});

test("getMiniMaxSubscriptionConfig returns unset when env is missing", () => {
  const keyBefore = process.env.MINIMAX_SUBSCRIPTION_KEY;
  delete process.env.MINIMAX_SUBSCRIPTION_KEY;

  try {
    const config = getMiniMaxSubscriptionConfig();
    assert.equal(config.keySet, false);
    assert.equal(config.key, undefined);
  } finally {
    if (keyBefore !== undefined) {
      process.env.MINIMAX_SUBSCRIPTION_KEY = keyBefore;
    }
  }
});

test("MiniMax subscription response never contains auth header or key", () => {
  const urlBefore = process.env.MINIMAX_BASE_URL;
  process.env.MINIMAX_BASE_URL = "https://api.minimax.io/v1";

  const status = parseMiniMaxTokenPlanResponse(
    JSON.stringify({
      model_remains: [
        {
          model_name: "general",
          current_interval_total_count: 100,
          current_interval_usage_count: 10,
          current_interval_remaining_percent: 90,
          current_interval_status: 0,
        },
      ],
    }),
    CHECKED_AT,
  );

  const json = JSON.stringify(status);
  assert.doesNotMatch(json, /Authorization/i);
  assert.doesNotMatch(json, /Bearer/i);
  assert.doesNotMatch(json, /test-key/i);
  assert.doesNotMatch(json, /MINIMAX_SUBSCRIPTION_KEY/i);
  assert.doesNotMatch(json, /api_key|apiKey|apikey/i);

  if (urlBefore !== undefined) {
    process.env.MINIMAX_BASE_URL = urlBefore;
  } else {
    delete process.env.MINIMAX_BASE_URL;
  }
});
