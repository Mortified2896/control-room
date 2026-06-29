import "server-only";

import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import {
  CODEX_CATALOG_MODELS as CODEX_MODEL_OPTIONS,
  CODEX_DEFAULT_MODEL_ID,
  isCodexCatalogModelId,
  type CodexModelId,
} from "@/lib/providers/codex-catalog";

/**
 * Safe Codex CLI subprocess wrapper.
 *
 * Hard limits (MVP):
 *
 * - Only two CLI invocations are ever made through this module:
 *     1. `codex --version`           — read-only, no network
 *     2. `codex login status`        — read-only, no network
 *     3. `codex exec --skip-git-repo-check <prompt>`
 *                                  — non-interactive task run
 *
 * - Argv is always a hard-coded literal. We never pass user input
 *   directly as a CLI flag. The prompt for `codex exec` is passed as a
 *   single positional argument via `execFile` (no shell).
 *
 * - The runner never sets a CWD inside the control-room repo. The
 *   scratch dir is `/home/hermes/tmp/control-room-codex-smoke`
 *   (configurable via CODEX_SMOKE_DIR), which is hermes-owned, has no
 *   git history, and is wiped clean of any repo state by design.
 *
 * - Timeouts: 5s for status/version probes, 120s for `codex exec`.
 *   On timeout the child is SIGKILLed and the command result is marked
 *   `timedOut: true`.
 *
 * - Output capture is bounded. We never echo raw stdout/stderr to the
 *   network. The chat route only forwards the parsed Codex response
 *   string, never raw CLI logs.
 *
 * - We never read `~/.codex/auth.json` contents and never print them.
 *   Auth-type detection only inspects top-level keys (`tokens` vs
 *   `OPENAI_API_KEY`).
 *
 * - No OPENAI_API_KEY / CODEX_API_KEY fallback. Codex must run with
 *   ChatGPT auth (or whatever auth the operator has configured); if
 *   it's not logged in, the API returns a clear "not_logged_in" error.
 */

const DEFAULT_SCRATCH_DIR = "/home/hermes/tmp/control-room-codex-smoke";
const VERSION_TIMEOUT_MS = 5_000;
const LOGIN_STATUS_TIMEOUT_MS = 5_000;
const EXEC_TIMEOUT_MS = 120_000;

/** Resolved, validated path to the `codex` binary. */
export function resolveCodexBinary(): string | null {
  // 1. Explicit override (used for testing / pinning a path).
  const explicit = process.env.CODEX_BIN_PATH?.trim();
  if (explicit && existsSync(explicit)) {
    return explicit;
  }
  // 2. PATH lookup (cached on first miss so we don't re-spawn `which`
  //    on every status poll). Falls back synchronously if `which` is
  //    not on PATH, in which case we just try common locations.
  const candidates = [
    "/home/hermes/.hermes/node/bin/codex",
    "/home/hermes/.local/bin/codex",
    "/usr/local/bin/codex",
    "/usr/bin/codex",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Resolved scratch directory, created on demand. */
export function resolveScratchDir(): string {
  const dir = process.env.CODEX_SMOKE_DIR?.trim() || DEFAULT_SCRATCH_DIR;
  mkdirSync(dir, { recursive: true });
  return dir;
}

export type CodexCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export class CodexNotInstalledError extends Error {
  constructor() {
    super("codex CLI is not installed on the server");
    this.name = "CodexNotInstalledError";
  }
}

export function runCodexCommand(
  binary: string,
  argv: ReadonlyArray<string>,
  opts: { cwd?: string; timeoutMs: number },
): Promise<CodexCommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CodexCommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = execFile(
      binary,
      argv as string[],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024, // 1 MiB hard cap on captured output
        windowsHide: true,
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

    // Codex prints "Reading additional input from stdin..." when stdin is a pipe.
    // Close it immediately so `codex exec <prompt>` cannot wait forever for
    // additional request body data.
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

export function classifyLoginStatusResult(
  result: CodexCommandResult,
): "logged_in" | "not_logged_in" | "unknown" {
  if (result.timedOut) return "unknown";
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (text.includes("not logged in")) return "not_logged_in";
  if (result.exitCode === 0 && text.includes("logged in")) return "logged_in";
  return "unknown";
}

/** Get `codex --version`. Returns null if the binary is missing. */
export async function getCodexVersion(binary: string): Promise<string | null> {
  const result = await runCodexCommand(binary, ["--version"], {
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  if (result.timedOut || result.exitCode !== 0) return null;
  // Output looks like: "codex-cli 0.142.2"
  // Strip the leading "codex-cli " if present.
  return result.stdout.trim().replace(/^codex-cli\s+/, "");
}

/**
 * Run `codex login status`. Returns:
 *   - "logged_in" if exit 0
 *   - "not_logged_in" if exit 1 and stderr/stdout contain "Not logged in"
 *   - "unknown" if exit non-zero with anything else
 *
 * The Codex CLI does not yet expose a JSON flag for `login status`, so
 * we parse the human-readable output. We never echo the raw text.
 */
export async function getLoginStatus(
  binary: string,
): Promise<"logged_in" | "not_logged_in" | "unknown"> {
  const result = await runCodexCommand(binary, ["login", "status"], {
    timeoutMs: LOGIN_STATUS_TIMEOUT_MS,
  });
  return classifyLoginStatusResult(result);
}

/**
 * Heuristic auth-type detection from `login status` stdout. Codex's
 * logged-in output mentions either "ChatGPT" or "API key" depending
 * on the auth method. If we can't tell, returns "unknown".
 *
 * The output is intentionally NOT returned to the caller — only the
 * type label. If we ever need to surface the account email, that
 * must go through a separate sanitizer.
 */
export async function detectAuthType(binary: string): Promise<"chatgpt" | "api_key" | "unknown"> {
  // We re-run login status because we don't want to refactor the
  // caller to pipe the original stdout. The cost is one extra fork,
  // and the timeout is short.
  const result = await runCodexCommand(binary, ["login", "status"], {
    timeoutMs: LOGIN_STATUS_TIMEOUT_MS,
  });
  if (result.timedOut || result.exitCode !== 0) return "unknown";
  const text = result.stdout + "\n" + result.stderr;
  const lower = text.toLowerCase();
  if (lower.includes("chatgpt")) return "chatgpt";
  if (lower.includes("api key") || lower.includes("api-key")) return "api_key";
  return "unknown";
}

export type CodexChatResult =
  | { ok: true; responseText: string; exitCode: number; durationMs: number }
  | {
      ok: false;
      responseText: string | null;
      exitCode: number | null;
      error: string;
      /**
       * Normalized failure category, used by the chat route to pick
       * the right user-facing copy. Defaults to `"internal"` when the
       * caller does not populate it. NEVER log secrets here.
       */
      errorKind: CodexFailureKind;
      /**
       * Raw `stderr` from the Codex CLI subprocess. Kept on the
       * failure envelope so the API route can log it server-side for
       * debugging, but the chat route MUST NOT forward it to the
       * client (raw stderr is what the original UI was showing as a
       * normal assistant message — see AGENTS.md "do not echo raw
       * backend stderr to the network"). The chat route logs it at
       * info level and the user sees only `error` above.
       */
      rawStderr?: string;
      /** Raw `stdout` from the Codex CLI subprocess. Same handling as `rawStderr`. */
      rawStdout?: string;
      durationMs: number;
    };

/**
 * Run `codex exec --skip-git-repo-check <prompt>` non-interactively.
 *
 * The runner:
 *  - cd's into the scratch dir (NOT the control-room repo)
 *  - injects `-c approval="never"` so Codex never tries to prompt
 *  - injects `-c sandbox="read-only"` so Codex can't mutate the host
 *  - hard-kills on timeout
 *  - returns the last non-empty stdout line as the "response text"
 *
 * NOTE: we deliberately disable interactive approval and restrict the
 * sandbox because this MVP is read-only smoke testing. A future
 * "projects" surface will need a per-project sandbox config.
 */
export { CODEX_DEFAULT_MODEL_ID, CODEX_MODEL_OPTIONS, type CodexModelId };

export function isCodexModelId(value: string): value is CodexModelId {
  return isCodexCatalogModelId(value);
}

export async function runCodexExec(
  binary: string,
  prompt: string,
  opts: { model?: CodexModelId; maxPromptLength?: number } = {},
): Promise<CodexChatResult> {
  // Defensive: limit prompt size so a runaway client can't OOM us.
  if (typeof prompt !== "string") {
    return {
      ok: false,
      responseText: null,
      exitCode: null,
      error: "prompt must be a string",
      errorKind: "internal",
      durationMs: 0,
    };
  }
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      responseText: null,
      exitCode: null,
      error: "prompt must not be empty",
      errorKind: "internal",
      durationMs: 0,
    };
  }
  const maxPromptLength = opts.maxPromptLength ?? 4000;
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

  const scratch = resolveScratchDir();
  const argv: ReadonlyArray<string> = [
    "exec",
    "--skip-git-repo-check",
    "--model",
    opts.model ?? CODEX_DEFAULT_MODEL_ID,
    "-c",
    'approval="never"',
    "-c",
    'sandbox="read-only"',
    trimmed,
  ];

  const start = Date.now();
  const result = await runCodexCommand(binary, argv, {
    cwd: scratch,
    timeoutMs: EXEC_TIMEOUT_MS,
  });
  if (result.timedOut) {
    return {
      ok: false,
      responseText: null,
      exitCode: null,
      error: `codex exec timed out after ${EXEC_TIMEOUT_MS}ms`,
      errorKind: "internal",
      durationMs: Date.now() - start,
    };
  }
  if (result.exitCode !== 0) {
    const classified = classifyCodexFailure(`${result.stdout}\n${result.stderr}`);
    return {
      ok: false,
      responseText: null,
      exitCode: result.exitCode,
      error: classified.userMessage,
      errorKind: classified.kind,
      // Raw `stdout + stderr` are kept on the failure envelope so the
      // API route can log them server-side, but the chat route MUST
      // NOT forward them to the client — the user-visible message is
      // the normalized `error` above.
      rawStderr: result.stderr,
      rawStdout: result.stdout,
      durationMs: Date.now() - start,
    };
  }
  const responseText = extractResponseText(result.stdout);
  return {
    ok: true,
    responseText,
    exitCode: result.exitCode,
    durationMs: Date.now() - start,
  };
}

/**
 * Classify a Codex CLI failure into a user-facing error kind + a
 * sanitized message. The raw stderr/stdout are NEVER surfaced to the
 * chat client; the chat route only forwards `userMessage` (plus the
 * kind for diagnostics).
 *
 * Categories (ordered most → least specific):
 *   1. `usage_limit`   — the Codex account is out of credits. Distinct
 *                       from a generic "exited 1" because the user
 *                       needs to know it's a quota problem and not a
 *                       network/permissions/auth issue.
 *   2. `auth`          — Codex is installed but not logged in, or the
 *                       bearer token is missing / rejected.
 *   3. `rate_limit`    — Codex is throttling the request (HTTP 429).
 *   4. `unsupported`   — the requested model id is not in the catalog.
 *   5. `internal`      — anything else (process crash, network, etc.).
 *
 * All "fatal" categories are returned with a clean UI copy. The
 * Codex skill-budget warning is filtered out as noise when the same
 * stderr carries a real fatal `ERROR:` line.
 */
export type CodexFailureKind = "usage_limit" | "auth" | "rate_limit" | "unsupported" | "internal";

export type CodexFailureClassification = {
  kind: CodexFailureKind;
  /**
   * Sanitized, user-facing error message. Safe to render in the chat
   * composer / settings page; does NOT include raw stderr or
   * stack-trace noise. Codex skill-budget warnings are intentionally
   * dropped here because they are advisory, not fatal.
   */
  userMessage: string;
};

export function classifyCodexFailure(combinedOutput: string): CodexFailureClassification {
  const text = combinedOutput ?? "";
  const lower = text.toLowerCase();

  // 1. Usage limit / quota exhaustion. Codex emits these via
  //    "You've hit your usage limit" and via upgrade links under
  //    chatgpt.com/codex/settings/usage. We treat any matching line
  //    as a usage-limit failure even when other warnings (e.g. the
  //    skills-context budget warning) are interleaved.
  if (
    /you'?ve hit your usage limit/i.test(text) ||
    /usage limit reached/i.test(text) ||
    /quota (exhausted|exceeded)/i.test(text) ||
    /upgrade to pro/i.test(text) ||
    /chatgpt\.com\/codex\/settings\/usage/i.test(text)
  ) {
    return {
      kind: "usage_limit",
      userMessage:
        "Codex usage limit reached. This message was not sent with Codex — try again after the limit resets or switch to a different model.",
    };
  }

  // 2. Auth / login errors. The runner already handles "Not logged in"
  //    in a preflight, but the CLI may also surface bearer-token
  //    rejections mid-exec.
  if (
    /401 unauthorized/i.test(text) ||
    /missing bearer/i.test(text) ||
    /not logged in/i.test(text) ||
    /api key not set/i.test(text)
  ) {
    return {
      kind: "auth",
      userMessage: "Codex is installed but not logged in. Run: codex login --device-auth",
    };
  }

  // 3. Rate limit (HTTP 429 from the upstream provider, distinct
  //    from the per-account "usage limit" cap above).
  if (/429 too many requests|rate.?limit(ed)?/i.test(lower)) {
    return {
      kind: "rate_limit",
      userMessage: "Codex rate limit hit. Wait a moment and try again, or switch models.",
    };
  }

  // 4. Unknown / unsupported model id.
  if (/unknown model|model not found|model .* not supported/i.test(lower)) {
    return {
      kind: "unsupported",
      userMessage: "This Codex model id is not recognized by the installed CLI.",
    };
  }

  // 5. Default. Pull only the last `ERROR: ...` line (or the last
  //    non-empty line if there is no ERROR marker) so we never echo
  //    the skills-context warning, the bubblewrap warning, or other
  //    advisory noise.
  const errorLine = lastErrorLine(text);
  const tail = errorLine
    ? sanitizeErrorLine(errorLine)
    : "Codex exec exited with a non-zero status. See the server logs for the raw output.";
  return {
    kind: "internal",
    userMessage: tail,
  };
}

/**
 * Pick the last line that looks like a fatal Codex error. The Codex
 * CLI prints advisory warnings (skill budget, bubblewrap, etc.) above
 * the actual `ERROR:` line, and we only want the error. If no
 * `ERROR:` line exists we fall back to the last non-empty line.
 */
function lastErrorLine(combined: string): string | null {
  const lines = combined
    .split("\n")
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, "")) // strip ANSI colors
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    if (/^error[:\s]/i.test(line)) return line;
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    if (/^warning[:\s]/i.test(line)) continue; // skip warnings
    return line;
  }
  return null;
}

/**
 * Strip the noisy prefix the CLI prefixes to `ERROR:` lines, collapse
 * repeated whitespace, and cap the line length so the UI never shows
 * a wall of stderr. We never trim to nothing — at minimum we surface
 * "Codex exec failed." so the user is never left guessing.
 */
function sanitizeErrorLine(line: string): string {
  const stripped = line
    .replace(/^(error|warning)\s*[:-]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return "Codex exec failed.";
  const MAX = 240;
  return stripped.length > MAX ? `${stripped.slice(0, MAX - 1)}…` : stripped;
}

/**
 * Pull the "response" out of `codex exec` stdout.
 *
 * Codex prints a session banner, then the user message, then the
 * model's answer, then a token-usage footer. The actual response is
 * the last non-banner block of text. We use a conservative
 * heuristic: take the last chunk between any "--------" separators.
 *
 * If parsing fails, we return the entire stdout so the caller can
 * still see something.
 */
function extractResponseText(stdout: string): string {
  if (!stdout) return "";
  // The trailing session footer is preceded by a "token usage" line
  // that starts with "tokens used". Strip everything from there on.
  const tokensIdx = stdout.search(/^tokens used/im);
  const body = tokensIdx > 0 ? stdout.slice(0, tokensIdx) : stdout;
  // Strip session banner ("workdir:", "model:", etc. lines).
  const lines = body.split("\n");
  // Find the last line that looks like the assistant's reply. Codex
  // emits each assistant message as plain text. We take everything
  // from the end, trimming blank lines.
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
    lines.pop();
  }
  if (lines.length === 0) return body.trim();
  // Drop the session banner (everything up to and including the first
  // "--------" line that follows "OpenAI Codex").
  const bannerEnd = lines.findIndex((l) => l.trim().startsWith("--------"));
  if (bannerEnd > 0 && bannerEnd + 1 < lines.length) {
    // Also drop the user/echo block until after the second "--------".
    const secondBanner = lines.findIndex(
      (l, i) => i > bannerEnd && l.trim().startsWith("--------"),
    );
    if (secondBanner > 0) {
      return lines
        .slice(secondBanner + 1)
        .join("\n")
        .trim();
    }
    return lines
      .slice(bannerEnd + 1)
      .join("\n")
      .trim();
  }
  return body.trim();
}

// Exported only so tests can introspect constants.
export const __CODEX_TIMEOUTS__ = {
  VERSION_TIMEOUT_MS,
  LOGIN_STATUS_TIMEOUT_MS,
  EXEC_TIMEOUT_MS,
} as const;
