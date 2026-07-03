import "server-only";

export type SubscriptionUsageSummaryItem = {
  label: string;
  used?: number;
  limit?: number;
  remaining?: number;
  remainingPercent?: number;
  resetAt?: string;
  window?: string;
};

export type SubscriptionUsageStatus = {
  provider: string;
  ok: boolean;
  source: string;
  checkedAt: string;
  rawAvailable: boolean;
  summary?: SubscriptionUsageSummaryItem[];
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
};

const SUBSCRIPTION_KEY_ENV = "MINIMAX_SUBSCRIPTION_KEY";
const DEFAULT_BASE_URL = "https://api.minimax.io/v1";
const FETCH_TIMEOUT_MS = 10_000;

type MiniMaxTokenPlanModel = Record<string, unknown>;

type MiniMaxTokenPlanResponse = {
  model_remains?: MiniMaxTokenPlanModel[];
  base_resp?: { status_code?: number; status_msg?: string };
};

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function epochMsToIso(ms: unknown): string | null {
  const n = num(ms);
  if (n === null) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseMiniMaxTokenPlanResponse(
  responseText: string,
  checkedAt: string,
): SubscriptionUsageStatus {
  try {
    const data = JSON.parse(responseText) as MiniMaxTokenPlanResponse;

    const baseResp = data.base_resp;
    if (baseResp && typeof baseResp.status_code === "number" && baseResp.status_code !== 0) {
      return {
        provider: "minimax",
        ok: false,
        source: "minimax:/v1/token_plan/remains",
        checkedAt,
        rawAvailable: false,
        error: {
          code: "minimax_token_plan_api_error",
          message:
            str(baseResp.status_msg) ??
            `MiniMax Token Plan API returned status code ${baseResp.status_code}`,
          retryable: false,
        },
      };
    }

    const models = arr(data.model_remains);
    if (models.length === 0) {
      return {
        provider: "minimax",
        ok: true,
        source: "minimax:/v1/token_plan/remains",
        checkedAt,
        rawAvailable: false,
        summary: [],
      };
    }

    const summary: SubscriptionUsageSummaryItem[] = [];
    for (const model of models) {
      if (!model || typeof model !== "object") continue;
      const m = model as Record<string, unknown>;
      const modelName = str(m.model_name) ?? "unknown";

      const intervalTotal = num(m.current_interval_total_count);
      const intervalUsed = num(m.current_interval_usage_count);
      const intervalRemainingPercent = num(m.current_interval_remaining_percent);
      const intervalStatus = num(m.current_interval_status);
      const intervalReset = epochMsToIso(m.end_time);

      const weeklyTotal = num(m.current_weekly_total_count);
      const weeklyUsed = num(m.current_weekly_usage_count);
      const weeklyRemainingPercent = num(m.current_weekly_remaining_percent);
      const weeklyStatus = num(m.current_weekly_status);
      const weeklyReset = epochMsToIso(m.weekly_end_time);

      const isNotInPlan = intervalStatus === 3 || (intervalTotal === 0 && intervalUsed === 0 && intervalRemainingPercent === 100);

      if (isNotInPlan && modelName !== "unknown") {
        summary.push({
          label: modelName,
          window: "not_in_plan",
        });
        continue;
      }

      if (intervalTotal !== null) {
        summary.push({
          label: modelName,
          used: intervalUsed ?? undefined,
          limit: intervalTotal,
          remaining: intervalTotal - (intervalUsed ?? 0),
          remainingPercent: intervalRemainingPercent ?? undefined,
          resetAt: intervalReset ?? undefined,
          window: "rolling_interval",
        });
      }

      if (weeklyTotal !== null && weeklyStatus !== 3) {
        summary.push({
          label: modelName,
          used: weeklyUsed ?? undefined,
          limit: weeklyTotal,
          remaining: weeklyTotal - (weeklyUsed ?? 0),
          remainingPercent: weeklyRemainingPercent ?? undefined,
          resetAt: weeklyReset ?? undefined,
          window: "weekly",
        });
      }
    }

    return {
      provider: "minimax",
      ok: true,
      source: "minimax:/v1/token_plan/remains",
      checkedAt,
      rawAvailable: summary.length > 0 && summary.some((s) => s.window !== "not_in_plan"),
      summary: summary.length > 0 ? summary : undefined,
    };
  } catch (err) {
    return {
      provider: "minimax",
      ok: false,
      source: "minimax:/v1/token_plan/remains",
      checkedAt,
      rawAvailable: false,
      error: {
        code: "invalid_minimax_usage_response",
        message: err instanceof Error ? err.message : "Failed to parse MiniMax Token Plan response",
        retryable: false,
      },
    };
  }
}

export function getMiniMaxSubscriptionConfig(): {
  keySet: boolean;
  key: string | undefined;
  baseURL: string;
} {
  const key = process.env[SUBSCRIPTION_KEY_ENV]?.trim() || undefined;
  return {
    keySet: Boolean(key),
    key,
    baseURL: process.env.MINIMAX_BASE_URL?.trim() || DEFAULT_BASE_URL,
  };
}

export async function fetchMiniMaxSubscriptionUsage(): Promise<SubscriptionUsageStatus> {
  const checkedAt = new Date().toISOString();
  const config = getMiniMaxSubscriptionConfig();

  if (!config.keySet || !config.key) {
    return {
      provider: "minimax",
      ok: false,
      source: "minimax:/v1/token_plan/remains",
      checkedAt,
      rawAvailable: false,
      error: {
        code: "missing_minimax_subscription_key",
        message: `MINIMAX_SUBSCRIPTION_KEY is not configured. Set ${SUBSCRIPTION_KEY_ENV} in the server environment.`,
        retryable: false,
      },
    };
  }

  const base = config.baseURL.replace(/\/+$/, "");
  const url = `${base}/token_plan/remains`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${config.key}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const text = await res.text();

    if (!res.ok) {
      let detail: string | undefined;
      try {
        const parsed = JSON.parse(text) as { base_resp?: { status_msg?: string } };
        detail = parsed.base_resp?.status_msg;
      } catch {
        // ignore parse errors on error responses
      }
      return {
        provider: "minimax",
        ok: false,
        source: `minimax:/v1/token_plan/remains (HTTP ${res.status})`,
        checkedAt,
        rawAvailable: false,
        error: {
          code: `minimax_http_${res.status}`,
          message: detail ?? `MiniMax Token Plan endpoint returned HTTP ${res.status}`,
          retryable: res.status >= 500 || res.status === 429,
        },
      };
    }

    return parseMiniMaxTokenPlanResponse(text, checkedAt);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        provider: "minimax",
        ok: false,
        source: "minimax:/v1/token_plan/remains",
        checkedAt,
        rawAvailable: false,
        error: {
          code: "minimax_subscription_timeout",
          message: `MiniMax Token Plan request timed out after ${FETCH_TIMEOUT_MS}ms`,
          retryable: true,
        },
      };
    }
    return {
      provider: "minimax",
      ok: false,
      source: "minimax:/v1/token_plan/remains",
      checkedAt,
      rawAvailable: false,
      error: {
        code: "minimax_subscription_network_error",
        message: err instanceof Error ? err.message : "MiniMax Token Plan request failed",
        retryable: true,
      },
    };
  }
}
