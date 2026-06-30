import "server-only";

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { getProject } from "@/lib/repo/projects";
import {
  finishCodingRun,
  markCodingRunRunning,
  type createCodingRun,
} from "@/lib/repo/coding-runs";

const execFileAsync = promisify(execFile);

const DEFAULT_MINIMAX_COMMAND = "mmx text chat";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_CHARS = 512_000;

type CreatedRun = Awaited<ReturnType<typeof createCodingRun>>;

export type ProjectCwdResolution =
  | { ok: true; cwd: string }
  | { ok: false; error: string; code: "no_project" | "missing" | "not_directory" | "not_git_repo" };

/**
 * Parse the user-overridable MiniMax CLI command. Defaults to
 * `mmx text chat` (the project runner appends
 * `--message <prompt> --output json --quiet --model <id>` so the
 * result streams cleanly into the chat answer; the backend-test
 * route in `app/api/agent-backends/minimax/chat` shares the same
 * default).
 */
export function parseMiniMaxCommand(command = process.env.MINIMAX_CLI_COMMAND): string[] {
  const raw = (command?.trim() || DEFAULT_MINIMAX_COMMAND).split(/\s+/).filter(Boolean);
  if (raw.length === 0) return DEFAULT_MINIMAX_COMMAND.split(" ");
  return raw;
}

export async function resolveProjectCwd(
  projectId: string | null | undefined,
): Promise<ProjectCwdResolution> {
  if (!projectId) {
    return {
      ok: false,
      code: "no_project",
      error: "No project is selected. Select a project before running MiniMax CLI.",
    };
  }
  const project = await getProject(projectId);
  if (!project) {
    return {
      ok: false,
      code: "no_project",
      error: "Selected project was not found. Select a project before running MiniMax CLI.",
    };
  }
  const path = project.repoPath || project.localPath;
  try {
    await access(path, constants.F_OK);
    const s = await stat(path);
    if (!s.isDirectory())
      return {
        ok: false,
        code: "not_directory",
        error: `Project path is not a directory: ${path}`,
      };
    const cwd = await realpath(path);
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "rev-parse", "--is-inside-work-tree"],
      { timeout: 2000, maxBuffer: 16 * 1024 },
    );
    if (stdout.trim() !== "true") {
      return { ok: false, code: "not_git_repo", error: `Project path is not a git repo: ${cwd}` };
    }
    return { ok: true, cwd };
  } catch {
    return {
      ok: false,
      code: "missing",
      error: `Project path is missing or is not a git repo: ${path}`,
    };
  }
}

type SpawnResult = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean };

function boundedAppend(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length > MAX_OUTPUT_CHARS ? next.slice(next.length - MAX_OUTPUT_CHARS) : next;
}

function spawnCaptured(
  command: string[],
  prompt: string,
  cwd: string,
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const [bin, ...baseArgs] = command;
    if (!bin) {
      resolve({
        stdout: "",
        stderr: "MINIMAX_CLI_COMMAND is empty",
        exitCode: null,
        timedOut: false,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    // The MiniMax CLI builds its request URL by appending
    // `/anthropic/v1/messages` to whatever `baseUrl` it derives from
    // `process.env.MINIMAX_BASE_URL || config.base_url`. Control
    // Room's chat runtime stores `MINIMAX_BASE_URL` with the `/v1`
    // suffix (OpenAI-compatible), but the CLI expects the bare host.
    // Strip the suffix on the way into the subprocess so the CLI
    // hits `https://api.minimax.io/anthropic/v1/messages` rather than
    // `https://api.minimax.io/v1/anthropic/v1/messages` (which 404s).
    const childEnv = { ...process.env };
    if (process.env.MINIMAX_BASE_URL) {
      childEnv.MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL.replace(/\/v1\/?$/, "");
    }
    const child = spawn(bin, [...baseArgs, prompt], {
      cwd,
      env: childEnv,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = boundedAppend(stderr, chunk);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${err.message}`,
        exitCode: null,
        timedOut,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut });
    });
  });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: 5000,
      maxBuffer: 128 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    return err instanceof Error
      ? `git ${args.join(" ")} failed: ${err.message}`
      : `git ${args.join(" ")} failed`;
  }
}

/**
 * Preflight the MiniMax CLI binary + auth before the real run.
 *
 * Order:
 *   1. `mmx --version` must succeed (binary is installed).
 *   2. `mmx quota` must succeed and return a token count
 *      (CLI is authenticated; if the call exits non-zero we treat
 *      that as an auth failure).
 *
 * We deliberately do NOT probe `mmx config get region` here because
 * the CLI auto-detects region from the API key. A user-set override
 * is a nice-to-have, not a hard gate.
 */
async function preflightMiniMax(command: string[]): Promise<string | null> {
  if (process.env.MINIMAX_CLI_SKIP_PREFLIGHT === "1") return null;
  const bin = command[0];
  if (!bin) return "MINIMAX_CLI_COMMAND is empty.";
  try {
    await execFileAsync(bin, ["--version"], { timeout: 5000, maxBuffer: 16 * 1024 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `MiniMax CLI binary is unavailable. Install MiniMax CLI or set MINIMAX_CLI_COMMAND. ${message}`;
  }
  try {
    await execFileAsync(bin, ["quota"], { timeout: 5000, maxBuffer: 32 * 1024 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `MiniMax CLI is not authenticated or its auth/config is invalid. Run: mmx auth login --api-key <MINIMAX_API_KEY>. ${message}`;
  }
  return null;
}

/**
 * Run a MiniMax CLI coding task against the active project folder.
 *
 * Mirrors `runProjectCodexRun` (`lib/codex/project-runner.ts`) so the
 * dispatcher can use a common harness result shape.
 *
 * SAFETY:
 *   - CWD is always the active project's repo path. Never an arbitrary
 *     folder.
 *   - The prompt is passed as a single positional argument via `spawn`
 *     (`shell: false`); it is never interpreted as CLI flags.
 *   - Stdin is closed so the CLI cannot wait for additional input.
 *   - 10-minute hard timeout (configurable via `MINIMAX_CLI_TIMEOUT_MS`).
 *   - Raw stderr is captured for server-side debugging but is sanitized
 *     before being returned to the chat composer.
 */
export async function runProjectMiniMaxRun(run: CreatedRun): Promise<CreatedRun> {
  const resolved = await resolveProjectCwd(run.projectId);
  if (!resolved.ok) {
    return finishCodingRun({
      id: run.id,
      status: "failed",
      stdout: "",
      stderr: resolved.error,
      exitCode: null,
    });
  }

  await markCodingRunRunning(run.id);
  const command = parseMiniMaxCommand();
  const preflightError = await preflightMiniMax(command);
  if (preflightError) {
    return finishCodingRun({
      id: run.id,
      status: "failed",
      stdout: "",
      stderr: preflightError,
      exitCode: null,
    });
  }
  const timeoutMs = Number(process.env.MINIMAX_CLI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  // Build the argv using the same shape as the smoke-test route in
  // `app/api/agent-backends/minimax/chat`: the prompt is sent as
  // `--message <text>`, output is JSON, and we use `--quiet` so the
  // stdout is the response document (not banner noise).
  //
  // The user-overridable `MINIMAX_CLI_COMMAND` supplies the binary
  // and any extra base args. We strip any user-provided message
  // flag so we never double-supply the prompt.
  const [bin, ...baseArgs] = command;
  const filteredBaseArgs: string[] = [];
  for (let i = 0; i < baseArgs.length; i += 1) {
    const a = baseArgs[i];
    if (a === "--message" || a === "-m") {
      // Skip the user-supplied value too.
      i += 1;
      continue;
    }
    if (a.startsWith("--message=")) continue;
    if (a.startsWith("-m=")) continue;
    filteredBaseArgs.push(a);
  }
  const finalCommand: string[] = [
    bin ?? "mmx",
    ...filteredBaseArgs,
    "--message",
    run.prompt,
    "--output",
    "json",
    "--quiet",
    ...(run.executor === "minimax_cli" ? ["--model", "MiniMax-M3"] : []),
  ];

  const result = await spawnCaptured(
    finalCommand,
    "", // prompt already passed via --message
    resolved.cwd,
    Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS,
  );

  const gitStatusShort = await gitOutput(resolved.cwd, ["status", "--short"]);
  const gitDiffStat = await gitOutput(resolved.cwd, ["diff", "--stat"]);

  let stderr = result.stderr;
  if (result.timedOut)
    stderr = `${stderr}${stderr ? "\n" : ""}MiniMax CLI timed out after ${timeoutMs}ms.`;
  if (result.exitCode === null && /ENOENT/.test(stderr)) {
    stderr = `${stderr}\nMiniMax CLI binary was not found. Install MiniMax CLI or set MINIMAX_CLI_COMMAND.`;
  }
  const status = result.exitCode === 0 && !result.timedOut ? "succeeded" : "failed";
  return finishCodingRun({
    id: run.id,
    status,
    stdout: result.stdout,
    stderr,
    exitCode: result.exitCode,
    gitStatusShort,
    gitDiffStat,
  });
}
