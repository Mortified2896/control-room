import assert from "node:assert/strict";
import test from "node:test";

import {
  msToHuman,
  parseMiniMaxTokenPlanResponse,
  fetchMiniMaxSubscriptionUsage,
  getMiniMaxSubscriptionConfig,
} from "./subscription-usage.ts";

const CHECKED_AT = "2026-07-03T12:00:00.000Z";

function setEnv(
  key: string | undefined,
  value: string | undefined,
): string | undefined {
  const before = process.env[key as string];
  if (value === undefined) {
    delete process.env[key as string];
  } else {
    process.env[key as string] = value;
  }
  return before;
}

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
): Promise<void> | void {
  const restore: Array<[string, string | undefined]> = [];
  for (const [k, v] of Object.entries(vars)) {
    restore.push([k, process.env[k]]);
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  const cleanup = () => {
    for (const [k, v] of restore) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  };
  let result: unknown;
  try {
    result = fn();
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result instanceof Promise) {
    return result.finally(cleanup);
  }
  cleanup();
}

function mockFetch(fn: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  return () => { globalThis.fetch = original; };
}

// ---------------------------------------------------------------------------
// Parser tests
// ---------------------------------------------------------------------------

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
      base_resp: { status_code: 1004, status_msg: "authentication failed" },
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
      base_resp: { status_code: 5001, status_msg: "internal server error" },
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

test("msToHuman returns correct labels", () => {
  assert.equal(msToHuman(0), "any moment");
  assert.equal(msToHuman(-1), "any moment");
  assert.equal(msToHuman(30_000), "<1m");
  assert.equal(msToHuman(2 * 60_000), "2m");
  assert.equal(msToHuman(65 * 60_000), "1h 5m");
  assert.equal(msToHuman(5 * 3_600_000 + 30 * 60_000), "5h 30m");
  assert.equal(msToHuman(24 * 3_600_000), "1d 0h");
  assert.equal(msToHuman(50 * 3_600_000 + 15 * 60_000), "2d 2h");
});

test("MiniMax subscription parser computes unified windows from model data", () => {
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
          current_weekly_total_count: 4_000_000,
          current_weekly_usage_count: 3_600_000,
          current_weekly_remaining_percent: 10,
          current_weekly_status: 0,
          weekly_end_time: 1781539200000,
        },
      ],
    }),
    "2026-07-03T12:00:00.000Z",
  );

  assert.equal(status.ok, true);
  assert.ok(status.windows);
  assert.equal(status.windows.length, 2);

  const fiveH = status.windows[0]!;
  assert.equal(fiveH.label, "5h limit");
  assert.equal(fiveH.windowType, "rolling_interval");
  assert.equal(fiveH.totalCount, 1_000_000);
  assert.equal(fiveH.usedCount, 350_000);
  assert.equal(fiveH.remainingCount, 650_000);
  assert.equal(fiveH.usedPercent, 35);
  assert.equal(fiveH.remainingPercent, 65);
  assert.ok(fiveH.resetInMs !== undefined);
  assert.ok(fiveH.resetInLabel !== undefined);

  const weekly = status.windows[1]!;
  assert.equal(weekly.label, "weekly limit");
  assert.equal(weekly.windowType, "weekly");
  assert.equal(weekly.totalCount, 4_000_000);
  assert.equal(weekly.usedCount, 3_600_000);
  assert.equal(weekly.usedPercent, 90);
  assert.equal(weekly.remainingPercent, 10);
});

test("MiniMax subscription parser computes unified windows across multiple models", () => {
  const status = parseMiniMaxTokenPlanResponse(
    JSON.stringify({
      model_remains: [
        {
          model_name: "general",
          current_interval_total_count: 800_000,
          current_interval_usage_count: 200_000,
          current_interval_remaining_percent: 75,
          current_interval_status: 0,
          end_time: 1780934400000,
          current_weekly_total_count: 2_000_000,
          current_weekly_usage_count: 500_000,
          current_weekly_remaining_percent: 75,
          current_weekly_status: 0,
          weekly_end_time: 1781539200000,
        },
        {
          model_name: "video",
          current_interval_total_count: 200_000,
          current_interval_usage_count: 50_000,
          current_interval_remaining_percent: 75,
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
    "2026-07-03T12:00:00.000Z",
  );

  assert.equal(status.ok, true);
  assert.ok(status.windows);
  assert.equal(status.windows.length, 2);

  // Interval sums: total=1M, used=250K
  const fiveH = status.windows[0]!;
  assert.equal(fiveH.totalCount, 1_000_000);
  assert.equal(fiveH.usedCount, 250_000);
  assert.equal(fiveH.usedPercent, 25);

  // Weekly sums: total=2.5M, used=600K
  const weekly = status.windows[1]!;
  assert.equal(weekly.totalCount, 2_500_000);
  assert.equal(weekly.usedCount, 600_000);
  assert.equal(weekly.usedPercent, 24);
});

test("MiniMax subscription parser uses API remaining_percent when counts are zero", () => {
  const status = parseMiniMaxTokenPlanResponse(
    JSON.stringify({
      model_remains: [
        {
          model_name: "general",
          current_interval_total_count: 0,
          current_interval_usage_count: 0,
          current_interval_remaining_percent: 100,
          current_interval_status: 1,
          end_time: 1783072800000,
          current_weekly_total_count: 0,
          current_weekly_usage_count: 0,
          current_weekly_remaining_percent: 9,
          current_weekly_status: 1,
          weekly_end_time: 1783296000000,
        },
      ],
    }),
    "2026-07-03T12:00:00.000Z",
  );

  assert.equal(status.ok, true);
  assert.equal(status.rawAvailable, true);
  assert.equal(status.windows?.length, 2);

  const fiveH = status.windows![0]!;
  assert.equal(fiveH.label, "5h limit");
  assert.equal(fiveH.usedPercent, 0);
  assert.equal(fiveH.remainingPercent, 100);
  assert.ok(fiveH.resetInLabel !== undefined);

  const weekly = status.windows![1]!;
  assert.equal(weekly.label, "weekly limit");
  assert.equal(weekly.usedPercent, 91);
  assert.equal(weekly.remainingPercent, 9);
  assert.ok(weekly.resetInLabel !== undefined);

  // Summary should show the model with API remaining_percent, not "not_in_plan"
  assert.equal(status.summary?.length, 2);
  assert.equal(status.summary![0]!.window, "rolling_interval");
  assert.equal(status.summary![0]!.remainingPercent, 100);
  assert.equal(status.summary![1]!.window, "weekly");
  assert.equal(status.summary![1]!.remainingPercent, 9);
});

test("MiniMax subscription parser does not emit windows when all models are not_in_plan", () => {
  const status = parseMiniMaxTokenPlanResponse(
    JSON.stringify({
      model_remains: [
        {
          model_name: "general",
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
  assert.equal(status.windows, undefined);
  assert.equal(status.rawAvailable, false);
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

// ---------------------------------------------------------------------------
// getMiniMaxSubscriptionConfig tests
// ---------------------------------------------------------------------------

test("getMiniMaxSubscriptionConfig prefers MINIMAX_SUBSCRIPTION_KEY over API key", () => {
  withEnv(
    {
      MINIMAX_SUBSCRIPTION_KEY: "sub-key",
      MINIMAX_API_KEY: "api-key",
    },
    () => {
      const config = getMiniMaxSubscriptionConfig();
      assert.equal(config.keySet, true);
      assert.equal(config.key, "sub-key");
      assert.equal(config.credentialSource, "MINIMAX_SUBSCRIPTION_KEY");
    },
  );
});

test("getMiniMaxSubscriptionConfig falls back to MINIMAX_API_KEY when subscription key is missing", () => {
  withEnv(
    {
      MINIMAX_SUBSCRIPTION_KEY: undefined,
      MINIMAX_API_KEY: "api-key",
    },
    () => {
      const config = getMiniMaxSubscriptionConfig();
      assert.equal(config.keySet, true);
      assert.equal(config.key, "api-key");
      assert.equal(config.credentialSource, "MINIMAX_API_KEY_LEGACY");
    },
  );
});

test("getMiniMaxSubscriptionConfig returns missing when both env vars are absent", () => {
  withEnv(
    {
      MINIMAX_SUBSCRIPTION_KEY: undefined,
      MINIMAX_API_KEY: undefined,
    },
    () => {
      const config = getMiniMaxSubscriptionConfig();
      assert.equal(config.keySet, false);
      assert.equal(config.key, undefined);
      assert.equal(config.credentialSource, "missing");
    },
  );
});

test("getMiniMaxSubscriptionConfig uses default base URL", () => {
  withEnv(
    {
      MINIMAX_SUBSCRIPTION_KEY: "sk",
      MINIMAX_BASE_URL: undefined,
    },
    () => {
      const config = getMiniMaxSubscriptionConfig();
      assert.ok(config.baseURL.includes("api.minimax.io"));
    },
  );
});

// ---------------------------------------------------------------------------
// fetchMiniMaxSubscriptionUsage tests
// ---------------------------------------------------------------------------

test("fetchMiniMaxSubscriptionUsage uses MINIMAX_SUBSCRIPTION_KEY when both are present", async () => {
  const restoreFetch = mockFetch(async (input, init) => {
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers?.Authorization, "Bearer preferred-key");
    return new Response(
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
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  await withEnv(
    {
      MINIMAX_SUBSCRIPTION_KEY: "preferred-key",
      MINIMAX_API_KEY: "legacy-key",
    },
    async () => {
      const status = await fetchMiniMaxSubscriptionUsage();

      assert.equal(status.ok, true);
      assert.equal(status.credentialSource, "MINIMAX_SUBSCRIPTION_KEY");
    },
  );

  restoreFetch();
});

test("fetchMiniMaxSubscriptionUsage falls back to MINIMAX_API_KEY when subscription key is missing", async () => {
  const restoreFetch = mockFetch(async (input, init) => {
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers?.Authorization, "Bearer legacy-key");
    return new Response(
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
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  await withEnv(
    {
      MINIMAX_SUBSCRIPTION_KEY: undefined,
      MINIMAX_API_KEY: "legacy-key",
    },
    async () => {
      const status = await fetchMiniMaxSubscriptionUsage();

      assert.equal(status.ok, true);
      assert.equal(status.credentialSource, "MINIMAX_API_KEY_LEGACY");
    },
  );

  restoreFetch();
});

test("fetchMiniMaxSubscriptionUsage missing both returns loud error", async () => {
  await withEnv(
    {
      MINIMAX_SUBSCRIPTION_KEY: undefined,
      MINIMAX_API_KEY: undefined,
    },
    async () => {
      const status = await fetchMiniMaxSubscriptionUsage();

      assert.equal(status.ok, false);
      assert.equal(status.credentialSource, "missing");
      assert.equal(status.error?.code, "missing_minimax_subscription_key");
      assert.ok(status.error?.message.includes("MINIMAX_SUBSCRIPTION_KEY"));
      assert.ok(status.error?.message.includes("MINIMAX_API_KEY"));
    },
  );
});

test("fetchMiniMaxSubscriptionUsage handles HTTP 401 from endpoint", async () => {
  const restoreFetch = mockFetch(async () => {
    return new Response(
      JSON.stringify({
        base_resp: { status_code: 1004, status_msg: "invalid key" },
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  });

  await withEnv(
    { MINIMAX_SUBSCRIPTION_KEY: "test-key-123" },
    async () => {
      const status = await fetchMiniMaxSubscriptionUsage();

      assert.equal(status.ok, false);
      assert.equal(status.credentialSource, "MINIMAX_SUBSCRIPTION_KEY");
      assert.equal(status.error?.code, "minimax_http_401");
      assert.equal(status.error?.retryable, false);
      assert.ok(status.error?.message.includes("invalid key"));
    },
  );

  restoreFetch();
});

test("fetchMiniMaxSubscriptionUsage handles HTTP 500 from endpoint as retryable", async () => {
  const restoreFetch = mockFetch(async () => {
    return new Response("Internal Server Error", { status: 500 });
  });

  await withEnv(
    { MINIMAX_SUBSCRIPTION_KEY: "test-key-123" },
    async () => {
      const status = await fetchMiniMaxSubscriptionUsage();

      assert.equal(status.ok, false);
      assert.equal(status.error?.code, "minimax_http_500");
      assert.equal(status.error?.retryable, true);
    },
  );

  restoreFetch();
});

test("fetchMiniMaxSubscriptionUsage handles network timeout", async () => {
  const restoreFetch = mockFetch(async (_input, init) => {
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
  });

  await withEnv(
    { MINIMAX_SUBSCRIPTION_KEY: "test-key-123" },
    async () => {
      const status = await fetchMiniMaxSubscriptionUsage();

      assert.equal(status.ok, false);
      assert.equal(status.error?.code, "minimax_subscription_timeout");
      assert.equal(status.error?.retryable, true);
    },
  );

  restoreFetch();
});

test("fetchMiniMaxSubscriptionUsage successful fetch with subscription key", async () => {
  const restoreFetch = mockFetch(async (input, init) => {
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
  });

  await withEnv(
    { MINIMAX_SUBSCRIPTION_KEY: "test-key-123" },
    async () => {
      const status = await fetchMiniMaxSubscriptionUsage();

      assert.equal(status.ok, true);
      assert.equal(status.provider, "minimax");
      assert.equal(status.credentialSource, "MINIMAX_SUBSCRIPTION_KEY");
      assert.equal(status.rawAvailable, true);
      assert.equal(status.summary?.length, 1);
      assert.equal(status.summary![0]!.label, "general");
      assert.equal(status.summary![0]!.remainingPercent, 90);
      assert.equal(status.error, undefined);
    },
  );

  restoreFetch();
});

test("legacy fallback wrong key type produces actionable error", async () => {
  const restoreFetch = mockFetch(async () => {
    return new Response(
      JSON.stringify({
        base_resp: {
          status_code: 1004,
          status_msg: "login fail: Please carry the API secret key in the 'Authorization' field of the request header",
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  await withEnv(
    {
      MINIMAX_SUBSCRIPTION_KEY: undefined,
      MINIMAX_API_KEY: "wrong-key-type",
    },
    async () => {
      const status = await fetchMiniMaxSubscriptionUsage();

      assert.equal(status.ok, false);
      assert.equal(status.credentialSource, "MINIMAX_API_KEY_LEGACY");
      assert.equal(status.error?.code, "minimax_legacy_key_rejected");
      assert.equal(status.error?.retryable, false);
      assert.ok(status.error?.message.includes("MINIMAX_API_KEY"));
      assert.ok(status.error?.message.includes("MINIMAX_SUBSCRIPTION_KEY"));
      assert.ok(status.error?.message.includes("rejected"));
    },
  );

  restoreFetch();
});

test("legacy fallback HTTP 401 with login fail also produces actionable error", async () => {
  const restoreFetch = mockFetch(async () => {
    return new Response(
      JSON.stringify({
        base_resp: {
          status_code: 1004,
          status_msg: "login fail: invalid key",
        },
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  });

  await withEnv(
    {
      MINIMAX_SUBSCRIPTION_KEY: undefined,
      MINIMAX_API_KEY: "bad-key",
    },
    async () => {
      const status = await fetchMiniMaxSubscriptionUsage();

      assert.equal(status.ok, false);
      assert.equal(status.error?.code, "minimax_legacy_key_rejected");
      assert.ok(status.error?.message.includes("MINIMAX_API_KEY"));
      assert.ok(status.error?.message.includes("rejected"));
    },
  );

  restoreFetch();
});

test("legacy fallback normal API error is not overridden", async () => {
  const restoreFetch = mockFetch(async () => {
    return new Response(
      JSON.stringify({
        base_resp: { status_code: 2001, status_msg: "rate limit exceeded" },
      }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
  });

  await withEnv(
    {
      MINIMAX_SUBSCRIPTION_KEY: undefined,
      MINIMAX_API_KEY: "some-key",
    },
    async () => {
      const status = await fetchMiniMaxSubscriptionUsage();

      assert.equal(status.ok, false);
      assert.equal(status.credentialSource, "MINIMAX_API_KEY_LEGACY");
      assert.equal(status.error?.code, "minimax_http_429");
      assert.equal(status.error?.retryable, true);
    },
  );

  restoreFetch();
});

test("response never contains secret values", () => {
  withEnv(
    {
      MINIMAX_SUBSCRIPTION_KEY: "hidden-sub-key",
      MINIMAX_API_KEY: "hidden-api-key",
      MINIMAX_BASE_URL: "https://api.minimax.io/v1",
    },
    () => {
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
      assert.doesNotMatch(json, /hidden-sub-key/i);
      assert.doesNotMatch(json, /hidden-api-key/i);
      // The credentialSource label "MINIMAX_SUBSCRIPTION_KEY" is a safe
      // label; only the credential value itself (hidden-sub-key) must
      // never appear.
    },
  );
});
