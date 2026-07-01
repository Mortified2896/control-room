import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type MiniMaxModelRemain = {
  modelName: string;
  currentIntervalRemainingPercent: number | null;
  currentWeeklyRemainingPercent: number | null;
};

export type MiniMaxUsage = {
  provider: "minimax_cli";
  status: "available" | "quota_limited" | "unknown" | "error";
  source: "mmx_quota" | "stderr_classifier" | "unknown";
  modelRemains: MiniMaxModelRemain[];
  remainingTokens: number | null;
  resetTime: string | null;
  rawSummary: string | null;
  checkedAt: string;
  error: { message: string; code?: string | null } | null;
};

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function parseMiniMaxQuotaJson(text: string, checkedAt = new Date().toISOString()): MiniMaxUsage {
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const sourceModels = arr(data.modelRemains ?? data.model_remains ?? data.models ?? data.quotas);
    const modelRemains = sourceModels
      .map((item) => {
        const o = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        const modelName = str(o.modelName ?? o.model_name ?? o.model) ?? "unknown";
        return {
          modelName,
          currentIntervalRemainingPercent: num(
            o.currentIntervalRemainingPercent ??
              o.current_interval_remaining_percent ??
              o.intervalRemainingPercent ??
              o.interval_remaining_percent,
          ),
          currentWeeklyRemainingPercent: num(
            o.currentWeeklyRemainingPercent ??
              o.current_weekly_remaining_percent ??
              o.weeklyRemainingPercent ??
              o.weekly_remaining_percent,
          ),
        };
      })
      .filter((m) => m.modelName !== "unknown" || m.currentIntervalRemainingPercent != null || m.currentWeeklyRemainingPercent != null);
    const remainingTokens = num(data.remainingTokens ?? data.remaining_tokens);
    const resetTime = str(data.resetTime ?? data.reset_time);
    const anyPositive = remainingTokens != null ? remainingTokens > 0 : modelRemains.some((m) => (m.currentIntervalRemainingPercent ?? 0) > 0 || (m.currentWeeklyRemainingPercent ?? 0) > 0);
    const anyZero = remainingTokens === 0 || modelRemains.some((m) => m.currentIntervalRemainingPercent === 0 || m.currentWeeklyRemainingPercent === 0);
    return {
      provider: "minimax_cli",
      status: anyPositive ? "available" : anyZero ? "quota_limited" : "unknown",
      source: "mmx_quota",
      modelRemains,
      remainingTokens,
      resetTime,
      rawSummary: modelRemains.length ? `${modelRemains.length} model quota entr${modelRemains.length === 1 ? "y" : "ies"}` : null,
      checkedAt,
      error: null,
    };
  } catch (err) {
    return {
      provider: "minimax_cli",
      status: "error",
      source: "unknown",
      modelRemains: [],
      remainingTokens: null,
      resetTime: null,
      rawSummary: null,
      checkedAt,
      error: { message: err instanceof Error ? err.message : "invalid quota json" },
    };
  }
}

export async function probeMiniMaxUsage(): Promise<MiniMaxUsage> {
  const checkedAt = new Date().toISOString();
  try {
    const { stdout } = await execFileAsync("mmx", ["quota", "show", "--output", "json"], {
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    });
    return parseMiniMaxQuotaJson(stdout, checkedAt);
  } catch (err) {
    const e = err as { message?: string; stderr?: string; code?: string | number };
    const summary = (e.stderr || e.message || "mmx quota failed").toString().slice(0, 500);
    return {
      provider: "minimax_cli",
      status: /network|timeout|enotfound|econn/i.test(summary) ? "unknown" : "error",
      source: "mmx_quota",
      modelRemains: [],
      remainingTokens: null,
      resetTime: null,
      rawSummary: null,
      checkedAt,
      error: { message: summary, code: e.code == null ? null : String(e.code) },
    };
  }
}
