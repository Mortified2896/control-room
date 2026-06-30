import "server-only";

import { spawn } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getProject } from "@/lib/repo/projects";
import {
  finishCodingRun,
  markCodingRunRunning,
  type createCodingRun,
} from "@/lib/repo/coding-runs";

const execFileAsync = promisify(execFile);
const DEFAULT_CODEX_COMMAND = "codex exec";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_CHARS = 512_000;

type CreatedRun = Awaited<ReturnType<typeof createCodingRun>>;

export type ProjectCwdResolution =
  | { ok: true; cwd: string }
  | { ok: false; error: string; code: "no_project" | "missing" | "not_directory" | "not_git_repo" };

export function parseCodexCommand(command = process.env.CODEX_CLI_COMMAND): string[] {
  const raw = (command?.trim() || DEFAULT_CODEX_COMMAND).split(/\s+/).filter(Boolean);
  if (raw.length === 0) return DEFAULT_CODEX_COMMAND.split(" ");
  return raw;
}

export async function resolveProjectCwd(projectId: string | null | undefined): Promise<ProjectCwdResolution> {
  if (!projectId) {
    return { ok: false, code: "no_project", error: "No project is selected. Select a project before running Codex CLI." };
  }
  const project = await getProject(projectId);
  if (!project) {
    return { ok: false, code: "no_project", error: "Selected project was not found. Select a project before running Codex CLI." };
  }
  const path = project.repoPath || project.localPath;
  try {
    await access(path, constants.F_OK);
    const s = await stat(path);
    if (!s.isDirectory()) return { ok: false, code: "not_directory", error: `Project path is not a directory: ${path}` };
    const cwd = await realpath(path);
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
      timeout: 2000,
      maxBuffer: 16 * 1024,
    });
    if (stdout.trim() !== "true") {
      return { ok: false, code: "not_git_repo", error: `Project path is not a git repo: ${cwd}` };
    }
    return { ok: true, cwd };
  } catch {
    return { ok: false, code: "missing", error: `Project path is missing or is not a git repo: ${path}` };
  }
}

type SpawnResult = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean };

function boundedAppend(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length > MAX_OUTPUT_CHARS ? next.slice(next.length - MAX_OUTPUT_CHARS) : next;
}

function spawnCaptured(command: string[], prompt: string, cwd: string, timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const [bin, ...baseArgs] = command;
    if (!bin) {
      resolve({ stdout: "", stderr: "CODEX_CLI_COMMAND is empty", exitCode: null, timedOut: false });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn(bin, [...baseArgs, prompt], { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
      resolve({ stdout, stderr: `${stderr}${stderr ? "\n" : ""}${err.message}`, exitCode: null, timedOut });
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
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { timeout: 5000, maxBuffer: 128 * 1024 });
    return stdout.trim();
  } catch (err) {
    return err instanceof Error ? `git ${args.join(" ")} failed: ${err.message}` : `git ${args.join(" ")} failed`;
  }
}

async function preflightCodex(command: string[]): Promise<string | null> {
  if (process.env.CODEX_CLI_SKIP_PREFLIGHT === "1") return null;
  const bin = command[0];
  if (!bin) return "CODEX_CLI_COMMAND is empty.";
  try {
    await execFileAsync(bin, ["--version"], { timeout: 5000, maxBuffer: 16 * 1024 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Codex CLI binary is unavailable. Install Codex CLI or set CODEX_CLI_COMMAND. ${message}`;
  }
  try {
    await execFileAsync(bin, ["login", "status"], { timeout: 5000, maxBuffer: 32 * 1024 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Codex CLI is not logged in or its auth/config is invalid. Run: codex login --device-auth. ${message}`;
  }
  return null;
}

export async function runProjectCodexRun(run: CreatedRun): Promise<CreatedRun> {
  const resolved = await resolveProjectCwd(run.projectId);
  if (!resolved.ok) {
    return finishCodingRun({ id: run.id, status: "failed", stdout: "", stderr: resolved.error, exitCode: null });
  }

  await markCodingRunRunning(run.id);
  const command = parseCodexCommand();
  const preflightError = await preflightCodex(command);
  if (preflightError) {
    return finishCodingRun({ id: run.id, status: "failed", stdout: "", stderr: preflightError, exitCode: null });
  }
  const timeoutMs = Number(process.env.CODEX_CLI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const result = await spawnCaptured(command, run.prompt, resolved.cwd, Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS);
  const gitStatusShort = await gitOutput(resolved.cwd, ["status", "--short"]);
  const gitDiffStat = await gitOutput(resolved.cwd, ["diff", "--stat"]);

  let stderr = result.stderr;
  if (result.timedOut) stderr = `${stderr}${stderr ? "\n" : ""}Codex CLI timed out after ${timeoutMs}ms.`;
  if (result.exitCode === null && /ENOENT/.test(stderr)) {
    stderr = `${stderr}\nCodex CLI binary was not found. Install Codex CLI or set CODEX_CLI_COMMAND to the server-side command.`;
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
