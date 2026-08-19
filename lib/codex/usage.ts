import "server-only";

export type CodexUsage = {
  provider: "codex_cli";
  status: "unknown" | "available" | "quota_limited" | "error";
  source: "codex_dashboard_unavailable" | "stderr_classifier" | "unknown";
  fiveHourLimit: null;
  weeklyLimit: null;
  credits: null;
  contextRemainingTokens: null;
  rawSummary: string | null;
  checkedAt: string;
  error: { message: string; code?: string | null } | null;
};

export function codexUsageUnknown(checkedAt = new Date().toISOString()): CodexUsage {
  return {
    provider: "codex_cli",
    status: "unknown",
    source: "codex_dashboard_unavailable",
    fiveHourLimit: null,
    weeklyLimit: null,
    credits: null,
    contextRemainingTokens: null,
    rawSummary: "Codex CLI does not expose non-interactive quota/usage; check the Codex dashboard.",
    checkedAt,
    error: null,
  };
}

export async function probeCodexUsage(): Promise<CodexUsage> {
  // `codex doctor --json` is machine-readable but does not expose quota/usage.
  // Do not scrape the TUI and do not invent remaining limits.
  return codexUsageUnknown();
}
