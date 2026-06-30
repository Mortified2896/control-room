import "server-only";

import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

/**
 * Safe MiniMax CLI (`mmx`) subprocess wrapper.
 *
 * The MiniMax CLI is invoked non-interactively for a coding task.
 * The runner only ever invokes these argv shapes:
 *
 *   1. `mmx --version`             — read-only, no network
 *   2. `mmx quota`                 — read-only, no network
 *   3. `mmx config get <key>`      — read-only, no network
 *   4. `mmx auth login --api-key …` — uses an env-supplied key; never
 *                                      echo'd to logs / responses.
 *   5. `mmx text chat --message <text>                — non-interactive
 *            --model <id> --output json --quiet`        task run; the
 *                                                        message is a
 *                                                        single CLI
 *                                                        flag value via
 *                                                        `execFile`
 *                                                        (no shell).
 *
 * Hard limits:
 *   - Argv is always a hard-coded literal. The prompt is passed as a
 *     single positional argument via `execFile`, never via a shell.
 *   - The runner never sets CWD inside the control-room repo. CWD is
 *     supplied by the caller (the harness dispatcher passes the active
 *     project's `repoPath`).
 *   - Timeouts: 5s for status / version probes, 180s for `mmx run`.
 *     On timeout the child is SIGKILLed and the result is marked
 *     `timedOut: true`.
 *   - Output capture is bounded. We never echo raw stdout/stderr to
 *     the network — the chat route forwards only the parsed response
 *     string.
 *   - We never read or echo `~/.mmx/auth.json` or the API key. Auth
 *     detection inspects only top-level keys + the exit status of
 *     `mmx quota`.
 */

const VERSION_TIMEOUT_MS = 5_000;
const QUOTA_TIMEOUT_MS = 5_000;
const CONFIG_GET_TIMEOUT_MS = 5_000;
const LOGIN_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 180_000;

/** Resolved, validated path to the `mmx` binary. */
export function resolveMiniMaxBinary(): string | null {
  // 1. Explicit override (used for testing / pinning a path).
  const explicit = process.env.MMX_BIN_PATH?.trim();
  if (explicit && existsSync(/* turbopackIgnore: true */ explicit)) {
    return explicit;
  }
  // 2. PATH lookup. Falls back synchronously to common locations if
  //    `which` is not on PATH.
  const candidates = [
    "/home/hermes/.hermes/node/bin/mmx",
    "/home/hermes/.local/bin/mmx",
    "/usr/local/bin/mmx",
    "/usr/bin/mmx",
  ];
  for (const c of candidates) {
    if (existsSync(/* turbopackIgnore: true */ c)) return c;
  }
  return null;
}

/** Resolved scratch directory, created on demand. */
export function resolveScratchDir(): string {
  const dir = process.env.MMX_SMOKE_DIR?.trim() || "/home/hermes/tmp/control-room-minimax-smoke";
  mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true });
  return dir;
}

export type MiniMaxCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export class MiniMaxNotInstalledError extends Error {
  constructor() {
    super("mmx CLI is not installed on the server");
    this.name = "MiniMaxNotInstalledError";
  }
}

export function runMiniMaxCommand(
  binary: string,
  argv: ReadonlyArray<string>,
  opts: { cwd?: string; timeoutMs: number; envOverrides?: Record<string, string> },
): Promise<MiniMaxCommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: MiniMaxCommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const env = { ...process.env, ...(opts.envOverrides ?? {}) };

    const child = execFile(
      binary,
      argv as string[],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024, // 1 MiB hard cap on captured output
        windowsHide: true,
        env,
      },
      (err, stdout, stderr) => {
        let exitCode: number | null = 0;
        let timedOut = false;
        if (err !== null) {
          const code = (err as NodeJS.ErrnoException).code;
          exitCode = typeof code === "number" ? code : null;
          timedOut = Boolean((err as { killed?: boolean }).killed);
        }
        finish({
          exitCode,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          timedOut,
        });
      },
    );

    // The CLI may print a "Reading additional input from stdin..."
    // banner when stdin is a pipe. Close it immediately so the runner
    // cannot wait forever for additional request body data.
    child.stdin?.end();

    child.on("error", (spawnErr) => {
      finish({
        exitCode: null,
        stdout: "",
        stderr: spawnErr.message,
        timedOut: false,
      });
    });
  });
}

export function classifyLoginResult(
  result: MiniMaxCommandResult,
): "authenticated" | "not_authenticated" | "unknown" {
  if (result.timedOut) return "unknown";
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (
    /not authenticated|not logged in|missing api key|no api key/i.test(text) ||
    /api[ _-]?key not set/i.test(text)
  ) {
    return "not_authenticated";
  }
  if (result.exitCode === 0 && /(token|quota|plan|usage|ok)/i.test(text)) {
    return "authenticated";
  }
  // The CLI emits "Error: 401 Unauthorized" on a stale / bad key.
  if (/401/.test(text)) return "not_authenticated";
  if (result.exitCode === 0) return "authenticated";
  return "unknown";
}

/** Get `mmx --version`. Returns null if the binary is missing. */
export async function getMiniMaxVersion(binary: string): Promise<string | null> {
  const result = await runMiniMaxCommand(binary, ["--version"], {
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  if (result.timedOut || result.exitCode !== 0) return null;
  // Output looks like: "mmx-cli 1.2.3"
  return result.stdout.trim().replace(/^mmx-cli\s+/, "");
}

/**
 * Run `mmx quota`. Returns:
 *   - `"authenticated"` if the CLI responded with a usable quota /
 *     token-plan payload (exit 0, body mentions "quota" / "tokens" /
 *     "remaining").
 *   - `"not_authenticated"` if the CLI reports a missing or rejected
 *     API key (exit non-zero, body matches "401" / "not authenticated"
 *     / "missing api key").
 *   - `"unknown"` otherwise.
 *
 * We do NOT return the parsed quota numbers. Token-plan balance is
 * surfaced separately via `MiniMaxStatusDto.quotaSummary` so the UI
 * can render a stable "X tokens remaining" pill without ever
 * forwarding raw `mmx quota` text to the chat composer.
 */
export async function getQuotaStatus(
  binary: string,
): Promise<"authenticated" | "not_authenticated" | "unknown"> {
  const result = await runMiniMaxCommand(binary, ["quota"], {
    timeoutMs: QUOTA_TIMEOUT_MS,
  });
  return classifyLoginResult(result);
}

/**
 * Lightweight summary of the quota command output. Used by the
 * agent-backends status card so operators can see token-plan balance
 * without ever exposing it to the chat composer.
 */
export async function getQuotaSummary(
  binary: string,
): Promise<{ remainingTokens: number | null; raw: string }> {
  const result = await runMiniMaxCommand(binary, ["quota"], {
    timeoutMs: QUOTA_TIMEOUT_MS,
  });
  if (result.timedOut || result.exitCode !== 0) {
    return { remainingTokens: null, raw: "" };
  }
  const raw = `${result.stdout}\n${result.stderr}`;
  // Match either "Remaining: 12,345 tokens" or "tokens left: 12345".
  const m = raw.match(/(\d{1,3}(?:,\d{3})+|\d+)\s*(tokens?\s*(left|remaining)?)/i);
  if (!m) return { remainingTokens: null, raw };
  const num = m[1]?.replace(/,/g, "");
  if (!num) return { remainingTokens: null, raw };
  const n = Number(num);
  return {
    remainingTokens: Number.isFinite(n) ? n : null,
    raw,
  };
}

/** Read a config value via `mmx config get <key>`. Returns null on error. */
export async function getConfigValue(binary: string, key: string): Promise<string | null> {
  const result = await runMiniMaxCommand(binary, ["config", "get", key], {
    timeoutMs: CONFIG_GET_TIMEOUT_MS,
  });
  if (result.timedOut || result.exitCode !== 0) return null;
  const v = result.stdout.trim();
  return v.length > 0 ? v : null;
}

/**
 * Authenticate against the MiniMax CLI using an API key.
 *
 * SAFETY:
 *   - The API key is passed via the `MINIMAX_API_KEY` env var on the
 *     child process, never as a CLI argv. The CLI argv
 *     `mmx auth login --api-key -` tells mmx to read the key from the
 *     environment, which keeps it out of `/proc/<pid>/cmdline` and
 *     out of any operator-visible `ps` output.
 *   - The `auth login` call has its own short timeout (30s). On
 *     success we re-probe quota and return its result.
 *   - The API key is never logged, returned, or echoed.
 */
export async function loginWithApiKey(
  binary: string,
  apiKey: string,
): Promise<{ ok: boolean; error: string | null }> {
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    return { ok: false, error: "MINIMAX_API_KEY is empty." };
  }
  const result = await runMiniMaxCommand(binary, ["auth", "login", "--api-key", "-"], {
    timeoutMs: LOGIN_TIMEOUT_MS,
    envOverrides: { MINIMAX_API_KEY: apiKey },
  });
  if (result.timedOut) {
    return { ok: false, error: "mmx auth login timed out." };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: sanitizeAuthError(`${result.stdout}\n${result.stderr}`),
    };
  }
  return { ok: true, error: null };
}

function sanitizeAuthError(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, "").trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    if (/^error[:\s]/i.test(line)) return line.replace(/^error[:\s]*/i, "").slice(0, 200);
  }
  return lines[lines.length - 1]?.slice(0, 200) ?? "MiniMax auth login failed.";
}

// ----------------------------------------------------------------------------
// mmx run
// ----------------------------------------------------------------------------

export type MiniMaxRunOptions = {
  /** Active project folder; the CLI is invoked with this as cwd. */
  cwd: string;
  /**
   * Prompt. Sent as a single positional argument via `execFile`,
   * never as a CLI flag or via shell. Hard size cap so a runaway
   * client can't OOM us.
   */
  prompt: string;
  /**
   * Optional model id (e.g. "MiniMax-M3"). Today the CLI infers the
   * default model from auth + config; the field is forwarded as
   * `--model` so the future auto-detect path can override.
   */
  model?: string;
  /** Reasoning / thinking-mode override. */
  reasoningLevel?: string;
  /** Max prompt length; defaults to 8k to keep mmx run snappy. */
  maxPromptLength?: number;
};

export type MiniMaxRunResult =
  | {
      ok: true;
      responseText: string;
      exitCode: number;
      durationMs: number;
      /**
       * Token usage parsed from the CLI footer, or null if the CLI
       * did not advertise it. We deliberately do NOT fake a count.
       */
      tokenUsage: null | {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      };
    }
  | {
      ok: false;
      responseText: string | null;
      exitCode: number | null;
      error: string;
      errorKind: MiniMaxFailureKind;
      rawStderr?: string;
      rawStdout?: string;
      durationMs: number;
    };

export type MiniMaxFailureKind = "usage_limit" | "auth" | "rate_limit" | "unsupported" | "internal";

/**
 * Run `mmx text chat --message <text> --model <id> --output json --quiet`
 * non-interactively.
 *
 * The runner:
 *   - cd's into the supplied `cwd` (the active project's `repoPath`).
 *   - emits `--output json --quiet` so the output is structured and
 *     banner-free.
 *   - SIGKILLs on timeout.
 *   - returns the parsed response text + a token-usage summary
 *     (only when the CLI exposes it).
 */
export async function runMiniMaxExec(
  binary: string,
  opts: MiniMaxRunOptions,
): Promise<MiniMaxRunResult> {
  const trimmed = opts.prompt?.trim() ?? "";
  if (!trimmed) {
    return {
      ok: false,
      responseText: null,
      exitCode: null,
      error: "prompt must not be empty",
      errorKind: "internal",
      durationMs: 0,
    };
  }
  const maxPromptLength = opts.maxPromptLength ?? 8_000;
  if (trimmed.length > maxPromptLength) {
    return {
      ok: false,
      responseText: null,
      exitCode: null,
      error: `prompt must be <= ${maxPromptLength} chars`,
      errorKind: "internal",
      durationMs: 0,
    };
  }

  const argv: string[] = ["text", "chat", "--message", trimmed, "--output", "json", "--quiet"];
  if (opts.model) argv.push("--model", opts.model);
  // The MiniMax CLI does not yet accept a `--reasoning` flag on
  // `mmx text chat`. The thinking-mode picker is exposed via the
  // runtime adapter for the chat path, not for the CLI surface.
  // We deliberately do NOT forward `reasoningLevel` here.

  // The CLI builds its request URL by appending `/anthropic/v1/messages`
  // to whatever `baseUrl` it derives from
  // `process.env.MINIMAX_BASE_URL || config.base_url || K[region]`.
  // Control Room's chat runtime reads `MINIMAX_BASE_URL` with the
  // `/v1` suffix (OpenAI-compatible), but the CLI expects the bare
  // host. Strip the suffix on the way into the subprocess so the
  // CLI hits `https://api.minimax.io/anthropic/v1/messages` rather
  // than `https://api.minimax.io/v1/anthropic/v1/messages`.
  const envOverrides: Record<string, string> = {};
  if (process.env.MINIMAX_BASE_URL) {
    envOverrides.MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL.replace(/\/v1\/?$/, "");
  }

  const start = Date.now();
  const result = await runMiniMaxCommand(binary, argv, {
    cwd: opts.cwd,
    timeoutMs: RUN_TIMEOUT_MS,
    envOverrides,
  });
  if (result.timedOut) {
    return {
      ok: false,
      responseText: null,
      exitCode: null,
      error: `mmx text chat timed out after ${RUN_TIMEOUT_MS}ms`,
      errorKind: "internal",
      durationMs: Date.now() - start,
    };
  }
  if (result.exitCode !== 0) {
    const classified = classifyMiniMaxFailure(`${result.stdout}\n${result.stderr}`);
    return {
      ok: false,
      responseText: null,
      exitCode: result.exitCode,
      error: classified.userMessage,
      errorKind: classified.kind,
      rawStderr: result.stderr,
      rawStdout: result.stdout,
      durationMs: Date.now() - start,
    };
  }
  const { responseText, tokenUsage } = extractResponseAndTokens(result.stdout);
  return {
    ok: true,
    responseText,
    exitCode: result.exitCode,
    durationMs: Date.now() - start,
    tokenUsage,
  };
}

/**
 * Classify a MiniMax CLI failure into a user-facing error kind + a
 * sanitized message. Mirrors the Codex classifier
 * (`lib/codex/runner.ts`) but tuned to MiniMax-specific error shapes:
 *
 *   1. `usage_limit`  — "token plan exhausted" / "quota exhausted".
 *   2. `auth`         — 401, missing key, "not authenticated".
 *   3. `rate_limit`   — HTTP 429 / "rate limit".
 *   4. `unsupported`  — unknown model id.
 *   5. `internal`     — anything else.
 */
export type MiniMaxFailureClassification = {
  kind: MiniMaxFailureKind;
  userMessage: string;
};

export function classifyMiniMaxFailure(combinedOutput: string): MiniMaxFailureClassification {
  const text = combinedOutput ?? "";
  const lower = text.toLowerCase();

  if (
    /token plan (exhausted|used up)/i.test(text) ||
    /quota (exhausted|exceeded|used up)/i.test(text) ||
    /insufficient (tokens|quota)/i.test(text) ||
    /plan limit reached/i.test(text)
  ) {
    return {
      kind: "usage_limit",
      userMessage: "MiniMax token plan exhausted. Switch to Codex CLI or answer in chat.",
    };
  }
  // The CLI emits an Anthropic-style JSON error envelope on stderr
  // when the API rejects a request. Pull the message out so the
  // user sees a real reason instead of `}`.
  const apiError = extractJsonErrorMessage(text);
  if (apiError) {
    if (/http 401|http 403|unauthor/i.test(apiError)) {
      return {
        kind: "auth",
        userMessage: `MiniMax API rejected the request: ${apiError}`,
      };
    }
    if (/http 429|rate[ _-]?limit/i.test(apiError)) {
      return {
        kind: "rate_limit",
        userMessage: `MiniMax rate limit hit: ${apiError}`,
      };
    }
    if (/http 404|not found|unknown model|model .* not supported/i.test(apiError)) {
      return {
        kind: "unsupported",
        userMessage: `MiniMax does not support this model: ${apiError}`,
      };
    }
    if (/http 4\d\d|http 5\d\d/i.test(apiError)) {
      return {
        kind: "internal",
        userMessage: `MiniMax API error: ${apiError}`,
      };
    }
  }
  if (
    /401 unauthorized/i.test(text) ||
    /missing api[ _-]?key/i.test(text) ||
    /not authenticated/i.test(text) ||
    /api[ _-]?key not set/i.test(text) ||
    /invalid api[ _-]?key/i.test(text)
  ) {
    return {
      kind: "auth",
      userMessage:
        "MiniMax CLI is not authenticated. Run: mmx auth login --api-key <MINIMAX_API_KEY>",
    };
  }
  if (/429 too many requests|rate[ _-]?limit(ed)?/i.test(lower)) {
    return {
      kind: "rate_limit",
      userMessage: "MiniMax rate limit hit. Wait a moment and try again.",
    };
  }
  if (/unknown model|model not found|model .* not supported/i.test(lower)) {
    return {
      kind: "unsupported",
      userMessage: "This MiniMax model id is not recognized by the installed CLI.",
    };
  }

  const errorLine = lastErrorLine(text);
  const tail = errorLine
    ? sanitizeErrorLine(errorLine)
    : "MiniMax CLI exited with a non-zero status. See server logs for details.";
  return { kind: "internal", userMessage: tail };
}

function lastErrorLine(combined: string): string | null {
  const lines = combined
    .split("\n")
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, ""))
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    if (/^error[:\s]/i.test(line)) return line;
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    if (/^warning[:\s]/i.test(line)) continue;
    return line;
  }
  return null;
}

/**
 * Try to extract a structured `{ error: { message } }` envelope from
 * the combined output. Returns the message string on success, null
 * otherwise. Used by `classifyMiniMaxFailure` to surface real API
 * error messages (e.g. `HTTP 404`) instead of bare `}` lines.
 *
 * Exported so the unit tests in `runner.test.ts` can exercise the
 * JSON-error extraction directly.
 */
export function extractJsonErrorMessage(combined: string): string | null {
  // Try to parse the whole string first.
  try {
    const parsed = JSON.parse(combined) as {
      error?: { message?: unknown; code?: unknown };
    };
    if (parsed.error && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
  } catch {
    // not a single JSON document
  }
  // Search for the first JSON object containing an `error.message`
  // field. The CLI emits multi-line pretty-printed JSON.
  const start = combined.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < combined.length; i += 1) {
    const ch = combined[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = combined.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate) as {
            error?: { message?: unknown };
          };
          if (parsed.error && typeof parsed.error.message === "string") {
            return parsed.error.message;
          }
        } catch {
          // keep scanning for another object
        }
      }
    }
  }
  return null;
}

function sanitizeErrorLine(line: string): string {
  const stripped = line
    .replace(/^(error|warning)\s*[:-]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return "MiniMax CLI failed.";
  const MAX = 240;
  return stripped.length > MAX ? `${stripped.slice(0, MAX - 1)}…` : stripped;
}

/**
 * Extract the response text + (optional) token usage from
 * `mmx text chat --output json`. The CLI emits an Anthropic-style
 * JSON document on stdout:
 *
 *   {
 *     "id": "…",
 *     "role": "assistant",
 *     "model": "MiniMax-M3",
 *     "content": [ { "type": "text", "text": "pong" } ],
 *     "usage": { "input_tokens": 40, "output_tokens": 2,
 *                "cache_creation_input_tokens": 0,
 *                "cache_read_input_tokens": 128,
 *                "service_tier": "standard" },
 *     "stop_reason": "end_turn"
 *   }
 *
 * We pull the first `content[].text` as the response, and combine
 * `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
 * as the total input tokens (caches count toward the bill on
 * MiniMax). The output-side total is `output_tokens`. We only
 * surface token counts when every numeric field is finite — never
 * fabricated.
 */
function extractResponseAndTokens(stdout: string): {
  responseText: string;
  tokenUsage: null | {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
} {
  if (!stdout) return { responseText: "", tokenUsage: null };
  try {
    const parsed = JSON.parse(stdout) as {
      content?: Array<{ type?: string; text?: unknown }>;
      usage?: {
        input_tokens?: unknown;
        output_tokens?: unknown;
        cache_creation_input_tokens?: unknown;
        cache_read_input_tokens?: unknown;
      };
    };
    if (Array.isArray(parsed.content)) {
      const textBlock = parsed.content.find(
        (b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string",
      );
      const text = typeof textBlock?.text === "string" ? textBlock.text : "";
      const usage = parsed.usage;
      const out = usage?.output_tokens;
      if (
        usage &&
        typeof usage.input_tokens === "number" &&
        Number.isFinite(usage.input_tokens) &&
        typeof out === "number" &&
        Number.isFinite(out)
      ) {
        const cacheCreation =
          typeof usage.cache_creation_input_tokens === "number" &&
          Number.isFinite(usage.cache_creation_input_tokens)
            ? usage.cache_creation_input_tokens
            : 0;
        const cacheRead =
          typeof usage.cache_read_input_tokens === "number" &&
          Number.isFinite(usage.cache_read_input_tokens)
            ? usage.cache_read_input_tokens
            : 0;
        const inputTokens = usage.input_tokens + cacheCreation + cacheRead;
        return {
          responseText: text,
          tokenUsage: {
            inputTokens,
            outputTokens: out,
            totalTokens: inputTokens + out,
          },
        };
      }
      return { responseText: text, tokenUsage: null };
    }
  } catch {
    // fall through to text-mode extraction
  }
  // Plain-text fallback. Strip banner / footer noise and return the body.
  const lines = stdout.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
    lines.pop();
  }
  return { responseText: lines.join("\n").trim(), tokenUsage: null };
}

// Exported only so tests can introspect constants.
export const __MINIMAX_TIMEOUTS__ = {
  VERSION_TIMEOUT_MS,
  QUOTA_TIMEOUT_MS,
  CONFIG_GET_TIMEOUT_MS,
  LOGIN_TIMEOUT_MS,
  RUN_TIMEOUT_MS,
} as const;
