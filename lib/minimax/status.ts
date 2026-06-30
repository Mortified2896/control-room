import "server-only";

import {
  classifyLoginResult,
  getMiniMaxVersion,
  getQuotaSummary,
  resolveMiniMaxBinary,
  runMiniMaxCommand,
} from "./runner";

export type MiniMaxAuthState = "authenticated" | "not_authenticated" | "unknown";

export type MiniMaxStatus = "not_installed" | "not_authenticated" | "logged_in" | "error";

export type MiniMaxStatusDto = {
  status: MiniMaxStatus;
  binary: {
    path: string | null;
    version: string | null;
    resolvedFrom: "env" | "PATH" | null;
  };
  region: string | null;
  authenticated: boolean;
  /**
   * Token-plan balance parsed from `mmx quota`, or `null` if the CLI
   * did not return a parseable number. Surfaced in the agent-backends
   * card only — never forwarded to the chat composer.
   */
  quotaSummary: {
    remainingTokens: number | null;
    lastCheckedAt: string | null;
  };
  lastCheckedAt: string;
  errorMessage: string | null;
};

const VERSION_TIMEOUT_MS = 5_000;
const QUOTA_TIMEOUT_MS = 5_000;
const CONFIG_GET_TIMEOUT_MS = 5_000;

export async function probeMiniMaxStatus(): Promise<MiniMaxStatusDto> {
  const lastCheckedAt = new Date().toISOString();
  const binaryPath = resolveMiniMaxBinary();
  if (!binaryPath) {
    return baseStatus("not_installed", null, null, null, lastCheckedAt);
  }
  const resolvedFrom = process.env.MMX_BIN_PATH?.trim() ? "env" : "PATH";
  const version = await getMiniMaxVersion(binaryPath).catch(() => null);

  // Run quota + config get region in parallel.
  const [quotaResult, region] = await Promise.all([
    getQuotaSummary(binaryPath).catch(() => ({ remainingTokens: null, raw: "" })),
    (async () => {
      const r = await runMiniMaxCommand(binaryPath, ["config", "get", "region"], {
        timeoutMs: CONFIG_GET_TIMEOUT_MS,
      });
      if (r.timedOut || r.exitCode !== 0) return null;
      const v = r.stdout.trim();
      return v.length > 0 ? v : null;
    })().catch(() => null),
  ]);

  // If `mmx quota` failed, attempt `mmx --version` as a smoke check and
  // re-classify the result so we can distinguish "CLI broken" from
  // "CLI ok, no auth".
  let loginState: MiniMaxAuthState = "unknown";
  if (quotaResult.remainingTokens != null) {
    loginState = "authenticated";
  } else {
    // Re-run quota purely to classify (no side effects).
    const probe = await runMiniMaxCommand(binaryPath, ["quota"], {
      timeoutMs: QUOTA_TIMEOUT_MS,
    });
    loginState = classifyLoginResult(probe);
  }

  const authenticated = loginState === "authenticated";

  if (!authenticated && loginState === "not_authenticated") {
    return {
      ...baseStatus("not_authenticated", binaryPath, version, resolvedFrom, lastCheckedAt),
      region,
      authenticated: false,
      quotaSummary: {
        remainingTokens: quotaResult.remainingTokens,
        lastCheckedAt,
      },
    };
  }
  if (loginState === "unknown") {
    return {
      ...baseStatus("error", binaryPath, version, resolvedFrom, lastCheckedAt),
      region,
      authenticated: false,
      quotaSummary: {
        remainingTokens: quotaResult.remainingTokens,
        lastCheckedAt,
      },
      errorMessage: "could not determine MiniMax authentication state",
    };
  }

  return {
    status: "logged_in",
    binary: { path: binaryPath, version, resolvedFrom },
    region,
    authenticated: true,
    quotaSummary: {
      remainingTokens: quotaResult.remainingTokens,
      lastCheckedAt,
    },
    lastCheckedAt,
    errorMessage: null,
  };
}

function baseStatus(
  status: MiniMaxStatus,
  binaryPath: string | null,
  version: string | null,
  resolvedFrom: "env" | "PATH" | null,
  lastCheckedAt: string,
): MiniMaxStatusDto {
  return {
    status,
    binary: { path: binaryPath, version, resolvedFrom },
    region: null,
    authenticated: false,
    quotaSummary: {
      remainingTokens: null,
      lastCheckedAt: null,
    },
    lastCheckedAt,
    errorMessage: null,
  };
}

// Keep this export so test imports do not flag it as unused.
export { VERSION_TIMEOUT_MS };
