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

export type MiniMaxUsageWindow = {
  label: string;
  windowType: "rolling_interval" | "weekly";
  totalCount: number;
  usedCount: number;
  remainingCount: number;
  usedPercent: number;
  remainingPercent: number;
  resetAt?: string;
  resetInMs?: number;
  resetInLabel?: string;
};

export type MiniMaxCredits = {
  available: boolean;
  balance?: number;
  label?: string;
};

export type MiniMaxUsageDetail = {
  label: string;
  tokens: number;
};

export type CredentialSource =
  | "MINIMAX_SUBSCRIPTION_KEY"
  | "MINIMAX_API_KEY_LEGACY"
  | "missing";

export type SubscriptionUsageStatus = {
  provider: string;
  ok: boolean;
  source: string;
  checkedAt: string;
  rawAvailable: boolean;
  credentialSource: CredentialSource;
  summary?: SubscriptionUsageSummaryItem[];
  windows?: MiniMaxUsageWindow[];
  credits?: MiniMaxCredits;
  usageDetails?: MiniMaxUsageDetail[];
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
};

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

export function msToHuman(ms: number): string {
  if (ms <= 0) return "any moment";
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return "<1m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours}h`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function parseMiniMaxTokenPlanResponse(
  responseText: string,
  checkedAt: string,
): SubscriptionUsageStatus & { _credentialSource?: CredentialSource } {
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
        credentialSource: "missing",
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
        credentialSource: "missing",
        summary: [],
      };
    }

    const summary: SubscriptionUsageSummaryItem[] = [];
    const checkedAtMs = new Date(checkedAt).getTime();

    let intervalTotalSum = 0;
    let intervalUsedSum = 0;
    let intervalAnyTotal = false;
    let intervalEarliestEndMs: number | null = null;
    let intervalApiRemainingPercent: number | null = null;

    let weeklyTotalSum = 0;
    let weeklyUsedSum = 0;
    let weeklyAnyTotal = false;
    let weeklyEarliestEndMs: number | null = null;
    let weeklyApiRemainingPercent: number | null = null;

    for (const model of models) {
      if (!model || typeof model !== "object") continue;
      const m = model as Record<string, unknown>;
      const modelName = str(m.model_name) ?? "unknown";

      const intervalTotal = num(m.current_interval_total_count);
      const intervalUsed = num(m.current_interval_usage_count);
      const intervalRemainingPercent = num(m.current_interval_remaining_percent);
      const intervalStatus = num(m.current_interval_status);
      const intervalReset = epochMsToIso(m.end_time);
      const intervalEndMs = num(m.end_time);

      const weeklyTotal = num(m.current_weekly_total_count);
      const weeklyUsed = num(m.current_weekly_usage_count);
      const weeklyRemainingPercent = num(m.current_weekly_remaining_percent);
      const weeklyStatus = num(m.current_weekly_status);
      const weeklyReset = epochMsToIso(m.weekly_end_time);
      const weeklyEndMs = num(m.weekly_end_time);

      const isNotInPlan = intervalStatus === 3;

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
        intervalTotalSum += intervalTotal;
        intervalUsedSum += intervalUsed ?? 0;
        intervalAnyTotal = true;
        if (intervalEndMs !== null && (intervalEarliestEndMs === null || intervalEndMs < intervalEarliestEndMs)) {
          intervalEarliestEndMs = intervalEndMs;
        }
        if (intervalRemainingPercent !== null) {
          intervalApiRemainingPercent = intervalApiRemainingPercent !== null
            ? Math.min(intervalApiRemainingPercent, intervalRemainingPercent)
            : intervalRemainingPercent;
        }
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
        weeklyTotalSum += weeklyTotal;
        weeklyUsedSum += weeklyUsed ?? 0;
        weeklyAnyTotal = true;
        if (weeklyEndMs !== null && (weeklyEarliestEndMs === null || weeklyEndMs < weeklyEarliestEndMs)) {
          weeklyEarliestEndMs = weeklyEndMs;
        }
        if (weeklyRemainingPercent !== null) {
          weeklyApiRemainingPercent = weeklyApiRemainingPercent !== null
            ? Math.min(weeklyApiRemainingPercent, weeklyRemainingPercent)
            : weeklyRemainingPercent;
        }
      }
    }

    const windows: MiniMaxUsageWindow[] = [];
    if (intervalAnyTotal) {
      const usedCount = intervalUsedSum;
      const totalCount = intervalTotalSum;
      const remainingCount = totalCount - usedCount;
      const remainingPercent = totalCount > 0
        ? Math.round(((totalCount - usedCount) / totalCount) * 100)
        : (intervalApiRemainingPercent ?? 100);
      const usedPercent = 100 - remainingPercent;
      const resetAt = intervalEarliestEndMs ? epochMsToIso(intervalEarliestEndMs) ?? undefined : undefined;
      const resetInMs = intervalEarliestEndMs && !Number.isNaN(checkedAtMs)
        ? Math.max(0, intervalEarliestEndMs - checkedAtMs)
        : undefined;
      windows.push({
        label: "5h limit",
        windowType: "rolling_interval",
        totalCount,
        usedCount,
        remainingCount,
        usedPercent,
        remainingPercent,
        resetAt,
        resetInMs,
        resetInLabel: resetInMs !== undefined ? msToHuman(resetInMs) : undefined,
      });
    }

    if (weeklyAnyTotal) {
      const usedCount = weeklyUsedSum;
      const totalCount = weeklyTotalSum;
      const remainingCount = totalCount - usedCount;
      const remainingPercent = totalCount > 0
        ? Math.round(((totalCount - usedCount) / totalCount) * 100)
        : (weeklyApiRemainingPercent ?? 100);
      const usedPercent = 100 - remainingPercent;
      const resetAt = weeklyEarliestEndMs ? epochMsToIso(weeklyEarliestEndMs) ?? undefined : undefined;
      const resetInMs = weeklyEarliestEndMs && !Number.isNaN(checkedAtMs)
        ? Math.max(0, weeklyEarliestEndMs - checkedAtMs)
        : undefined;
      windows.push({
        label: "weekly limit",
        windowType: "weekly",
        totalCount,
        usedCount,
        remainingCount,
        usedPercent,
        remainingPercent,
        resetAt,
        resetInMs,
        resetInLabel: resetInMs !== undefined ? msToHuman(resetInMs) : undefined,
      });
    }

    return {
      provider: "minimax",
      ok: true,
      source: "minimax:/v1/token_plan/remains",
      checkedAt,
      rawAvailable: summary.length > 0 && summary.some((s) => s.window !== "not_in_plan"),
      credentialSource: "missing",
      summary: summary.length > 0 ? summary : undefined,
      windows: windows.length > 0 ? windows : undefined,
    };
  } catch (err) {
    return {
      provider: "minimax",
      ok: false,
      source: "minimax:/v1/token_plan/remains",
      checkedAt,
      rawAvailable: false,
      credentialSource: "missing",
      error: {
        code: "invalid_minimax_usage_response",
        message: err instanceof Error ? err.message : "Failed to parse MiniMax Token Plan response",
        retryable: false,
      },
    };
  }
}

export type MiniMaxSubscriptionConfig = {
  keySet: boolean;
  key: string | undefined;
  credentialSource: CredentialSource;
  baseURL: string;
};

export function getMiniMaxSubscriptionConfig(): MiniMaxSubscriptionConfig {
  const subscriptionKey = process.env.MINIMAX_SUBSCRIPTION_KEY?.trim();
  if (subscriptionKey) {
    return {
      keySet: true,
      key: subscriptionKey,
      credentialSource: "MINIMAX_SUBSCRIPTION_KEY",
      baseURL: process.env.MINIMAX_BASE_URL?.trim() || DEFAULT_BASE_URL,
    };
  }

  const legacyKey = process.env.MINIMAX_API_KEY?.trim();
  if (legacyKey) {
    return {
      keySet: true,
      key: legacyKey,
      credentialSource: "MINIMAX_API_KEY_LEGACY",
      baseURL: process.env.MINIMAX_BASE_URL?.trim() || DEFAULT_BASE_URL,
    };
  }

  return {
    keySet: false,
    key: undefined,
    credentialSource: "missing",
    baseURL: process.env.MINIMAX_BASE_URL?.trim() || DEFAULT_BASE_URL,
  };
}

function isLoginFailResponse(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { base_resp?: { status_code?: unknown; status_msg?: unknown } };
    const statusCode = parsed.base_resp?.status_code;
    const statusMsg = parsed.base_resp?.status_msg;
    if (typeof statusCode === "number" && statusCode !== 0) {
      if (typeof statusMsg === "string" && /login fail/i.test(statusMsg)) {
        return true;
      }
    }
  } catch {
    // ignore parse errors
  }
  return false;
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
      credentialSource: "missing",
      error: {
        code: "missing_minimax_subscription_key",
        message:
          "Set MINIMAX_SUBSCRIPTION_KEY. Legacy fallback MINIMAX_API_KEY is also supported temporarily.",
        retryable: false,
      },
    };
  }

  const base = config.baseURL.replace(/\/+$/, "");
  const url = `${base}/token_plan/remains`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let res: Response;
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

    const isLegacyWrongKey =
      config.credentialSource === "MINIMAX_API_KEY_LEGACY" &&
      isLoginFailResponse(text);

    if (isLegacyWrongKey) {
      return {
        provider: "minimax",
        ok: false,
        source: "minimax:/v1/token_plan/remains",
        checkedAt,
        rawAvailable: false,
        credentialSource: "MINIMAX_API_KEY_LEGACY",
        error: {
          code: "minimax_legacy_key_rejected",
          message:
            "The configured MINIMAX_API_KEY was tried as a legacy subscription key, but MiniMax rejected it. Set MINIMAX_SUBSCRIPTION_KEY to the Token Plan subscription key.",
          retryable: false,
        },
      };
    }

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
        credentialSource: config.credentialSource,
        error: {
          code: `minimax_http_${res.status}`,
          message: detail ?? `MiniMax Token Plan endpoint returned HTTP ${res.status}`,
          retryable: res.status >= 500 || res.status === 429,
        },
      };
    }

    const parsed = parseMiniMaxTokenPlanResponse(text, checkedAt);
    return {
      ...parsed,
      credentialSource: config.credentialSource,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        provider: "minimax",
        ok: false,
        source: "minimax:/v1/token_plan/remains",
        checkedAt,
        rawAvailable: false,
        credentialSource: config.credentialSource,
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
      credentialSource: config.credentialSource,
      error: {
        code: "minimax_subscription_network_error",
        message: err instanceof Error ? err.message : "MiniMax Token Plan request failed",
        retryable: true,
      },
    };
  }
}
