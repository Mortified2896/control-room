import assert from "node:assert/strict";
import test from "node:test";

import { GET } from "./route.ts";

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
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(cleanup);
    }
    cleanup();
  } catch (err) {
    cleanup();
    throw err;
  }
}

function mockFetch(
  fn: (
    input: URL | RequestInfo,
    init?: RequestInit,
  ) => Promise<Response>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  return () => {
    globalThis.fetch = original;
  };
}

/**
 * The API route always returns HTTP 200 with an array of provider
 * statuses. Each status encodes errors as `ok: false` with a clear
 * error object — the route must never leak secrets or 500 on
 * provider-level failures.
 */
test("subscription-usage route returns statuses array with minimax entry", async () => {
  await withEnv(
    {
      MINIMAX_SUBSCRIPTION_KEY: undefined,
      MINIMAX_API_KEY: undefined,
    },
    async () => {
      const response = await GET();
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.ok(Array.isArray(body.statuses));
      assert.ok(body.statuses.length >= 1);

      const minimax = body.statuses.find(
        (s: { provider: string }) => s.provider === "minimax",
      );
      assert.ok(minimax, "expected minimax status entry");
      assert.equal(minimax.ok, false);
      assert.equal(minimax.credentialSource, "missing");
      assert.equal(minimax.error?.code, "missing_minimax_subscription_key");
    },
  );
});

test("subscription-usage route response never contains secrets", async () => {
  const restoreFetch = mockFetch(async () => {
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
  });

  await withEnv(
    {
      MINIMAX_SUBSCRIPTION_KEY: "test-secret-key-456",
      MINIMAX_API_KEY: "another-secret",
    },
    async () => {
      const response = await GET();
      const body = await response.json();
      const json = JSON.stringify(body);

      // The credentialSource field exposes which env var was used as a
      // safe label, but never the credential value itself.
      assert.doesNotMatch(json, /Authorization/i);
      assert.doesNotMatch(json, /Bearer/i);
      assert.doesNotMatch(json, /test-secret-key/i);
      assert.doesNotMatch(json, /another-secret/i);
    },
  );

  restoreFetch();
});

test("subscription-usage route returns ok:false without crashing on HTTP errors", async () => {
  const restoreFetch = mockFetch(async () => {
    return new Response("Unauthorized", { status: 401 });
  });

  await withEnv(
    {
      MINIMAX_SUBSCRIPTION_KEY: "some-key",
      MINIMAX_API_KEY: undefined,
    },
    async () => {
      const response = await GET();
      assert.equal(response.status, 200);

      const body = await response.json();
      const minimax = body.statuses.find(
        (s: { provider: string }) => s.provider === "minimax",
      );
      assert.ok(minimax);
      assert.equal(minimax.ok, false);
      assert.equal(minimax.credentialSource, "MINIMAX_SUBSCRIPTION_KEY");
      assert.equal(minimax.error?.code, "minimax_http_401");
      assert.equal(minimax.error?.retryable, false);
    },
  );

  restoreFetch();
});

test("subscription-usage route returns 200 with Cache-Control: no-store", async () => {
  await withEnv(
    {
      MINIMAX_SUBSCRIPTION_KEY: undefined,
      MINIMAX_API_KEY: undefined,
    },
    async () => {
      const response = await GET();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
    },
  );
});

test("subscription-usage route returns credential source in response", async () => {
  const restoreFetch = mockFetch(async () => {
    return new Response(
      JSON.stringify({
        model_remains: [
          {
            model_name: "general",
            current_interval_total_count: 500,
            current_interval_usage_count: 50,
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
      MINIMAX_SUBSCRIPTION_KEY: "my-key",
      MINIMAX_API_KEY: undefined,
    },
    async () => {
      const response = await GET();
      const body = await response.json();
      const minimax = body.statuses.find(
        (s: { provider: string }) => s.provider === "minimax",
      );

      assert.ok(minimax);
      assert.equal(minimax.credentialSource, "MINIMAX_SUBSCRIPTION_KEY");
    },
  );

  restoreFetch();
});
