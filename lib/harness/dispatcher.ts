import "server-only";

import { runProjectCodexRun, type ProjectCwdResolution } from "@/lib/codex/project-runner";
import { runProjectMiniMaxRun } from "@/lib/minimax/project-runner";
import { getProject } from "@/lib/repo/projects";
import { resolveProjectCwd as resolveCodexProjectCwd } from "@/lib/codex/project-runner";
import { resolveProjectCwd as resolveMiniMaxProjectCwd } from "@/lib/minimax/project-runner";
import { getHarnessEntry, type HarnessId, type HarnessRegistryEntry } from "./registry";

/**
 * Generic coding harness dispatcher.
 *
 * Used by `/api/coding-runs` to run a coding task against the active
 * project folder using one of the registered harnesses. The dispatcher:
 *
 *   1. Resolves the harness from `harnessId`.
 *   2. Resolves the project's working directory (every registered
 *      harness today requires a project folder).
 *   3. Validates the model id against the harness's `allowedModelIds`.
 *   4. Creates a `coding_runs` row and dispatches to the
 *      harness-specific runner (`runProjectCodexRun` /
 *      `runProjectMiniMaxRun`).
 *   5. Returns the unified `CodingHarnessResult` so the chat composer
 *      can render a single metadata pill regardless of which harness
 *      ran.
 *
 * No silent harness fallback: a call to `dispatchCodingHarness({harnessId:"codex_cli", …})`
 * ALWAYS routes to Codex. To route to MiniMax, pass
 * `harnessId:"minimax_cli"`. The chat composer picks the harness id;
 * the dispatcher never overrides it.
 */

export type CodingHarnessRequest = {
  harnessId: HarnessId;
  /**
   * Bare model id (e.g. `gpt-5.4-mini` or `MiniMax-M3`) — without
   * the `codex:` / `minimax:` prefix. The dispatcher forwards the
   * raw id to the harness runner.
   */
  modelId: string;
  /** Provider-native reasoning / thinking level value. */
  reasoningLevel: string;
  /** The prompt to send to the harness. */
  prompt: string;
  /** Active project id (must resolve to a real working directory). */
  projectId: string;
  /** Optional thread id; persisted onto the `coding_runs` row. */
  threadId?: string | null;
};

export type CodingHarnessResult = {
  /** Harness id actually used (always matches the request). */
  harnessId: HarnessId;
  /** Bare model id actually used. */
  modelId: string;
  /** Provider-native reasoning level actually used. */
  reasoningLevel: string;
  /** Resolved working directory the CLI ran against. */
  projectPath: string;
  /** True iff the harness subprocess exited 0 within the timeout. */
  success: boolean;
  /** Captured stdout from the harness subprocess. */
  output: string;
  /** Sanitized stderr (never raw CLI banners / secrets). */
  stderr: string | null;
  /** Exit code from the harness subprocess. */
  exitStatus: number | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  /**
   * Files changed in the project as reported by `git status --short`.
   * Populated when the harness writes to the project folder AND the
   * runner captured the git status. Empty for failed runs.
   */
  changedFiles: string[];
  /** Coarse classification; surfaced as the pill status. */
  status: "queued" | "running" | "succeeded" | "failed";
  /**
   * Token usage parsed from the harness, or null. The harness
   * registry declares whether each harness supports token usage;
   * when `false`, this field is always `null`.
   */
  tokenUsage: null | {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  error: null | {
    message: string;
    kind: string;
  };
  /** Row id of the `coding_runs` row written for this run. */
  codingRunId: string;
};

/**
 * Resolved harness spec after the dispatcher has confirmed the model
 * is allowed and the harness entry exists. Used internally before we
 * actually invoke the runner.
 */
type ResolvedHarness = {
  harness: HarnessRegistryEntry;
  cwd: string;
};

/**
 * Validate the request shape and resolve the harness entry + project
 * cwd. Throws `HarnessDispatchError` on any validation failure so the
 * route can surface a clean 4xx response.
 */
export async function resolveHarnessForRequest(
  req: CodingHarnessRequest,
): Promise<ResolvedHarness> {
  const harness = getHarnessEntry(req.harnessId);
  if (!req.prompt || req.prompt.trim().length === 0) {
    throw new HarnessDispatchError("prompt must not be empty", "invalid_request", 400);
  }
  if (!req.projectId) {
    throw new HarnessDispatchError("project_required", "invalid_request", 400);
  }
  const project = await getProject(req.projectId);
  if (!project) {
    throw new HarnessDispatchError("project_not_found", "invalid_request", 404);
  }
  if (harness.requiresProjectFolder) {
    const cwd = await resolveCwdForHarness(harness.id, req.projectId);
    if (!cwd.ok) {
      throw new HarnessDispatchError(cwd.error, cwd.code, 400);
    }
    return { harness, cwd: cwd.cwd };
  }
  // Harness without a project requirement: fall back to /tmp.
  return { harness, cwd: "/tmp" };
}

async function resolveCwdForHarness(
  harnessId: HarnessId,
  projectId: string,
): Promise<ProjectCwdResolution> {
  // Both harnesses today reuse the same resolution contract. We pass
  // through the harness-specific module so the per-harness error
  // messages mention the right CLI ("… before running Codex CLI." vs
  // "… before running MiniMax CLI.").
  if (harnessId === "codex_cli") {
    return resolveCodexProjectCwd(projectId);
  }
  if (harnessId === "minimax_cli") {
    return resolveMiniMaxProjectCwd(projectId);
  }
  throw new HarnessDispatchError(`Unknown harness: ${harnessId}`, "unknown_harness", 400);
}

export class HarnessDispatchError extends Error {
  status: number;
  kind: string;
  constructor(message: string, kind: string, status: number) {
    super(message);
    this.name = "HarnessDispatchError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Dispatch a coding task to the requested harness and return the
 * unified `CodingHarnessResult`. The harness-specific runners handle
 * `coding_runs` row creation, status transitions, and git status
 * capture; we only translate between their row shape and the unified
 * dispatcher shape.
 *
 * IMPORTANT: this function does NOT insert the user / assistant
 * message into the chat thread — that is the responsibility of the
 * route handler so the thread-side effect stays in one place.
 */
export async function dispatchCodingHarness(
  req: CodingHarnessRequest,
): Promise<CodingHarnessResult> {
  const { harness, cwd } = await resolveHarnessForRequest(req);

  // Validate the model id against the harness allowlist.
  if (!harness.allowedModelIds.includes(stripHarnessPrefix(req.modelId, harness.id))) {
    throw new HarnessDispatchError(
      `${harness.displayName} does not support model ${req.modelId}. Allowed: ${harness.allowedModelIds.join(", ")}.`,
      "model_not_supported",
      400,
    );
  }

  // Lazy import the repo helper to avoid pulling the `coding_runs`
  // row creator into the sync helper path.
  const { createCodingRun } = await import("@/lib/repo/coding-runs");
  const runRow = await createCodingRun({
    projectId: req.projectId,
    threadId: req.threadId ?? null,
    prompt: req.prompt,
    executor: harness.id,
  });

  const completed =
    harness.id === "codex_cli"
      ? await runProjectCodexRun(runRow)
      : await runProjectMiniMaxRun(runRow);

  const durationMs =
    completed.startedAt && completed.finishedAt
      ? Math.max(0, Date.parse(completed.finishedAt) - Date.parse(completed.startedAt))
      : 0;

  const changedFiles = parseGitStatusShort(completed.gitStatusShort);

  return {
    harnessId: harness.id,
    modelId: stripHarnessPrefix(req.modelId, harness.id),
    reasoningLevel: req.reasoningLevel,
    projectPath: cwd,
    success: completed.status === "succeeded",
    output: completed.stdout,
    stderr: completed.stderr?.trim() || null,
    exitStatus: completed.exitCode,
    startedAt: completed.startedAt ?? new Date().toISOString(),
    completedAt: completed.finishedAt ?? new Date().toISOString(),
    durationMs,
    changedFiles,
    status: completed.status,
    // Token usage is not surfaced by the project runner today; we
    // intentionally return `null` so the UI shows "no token usage
    // reported" rather than a fake number.
    tokenUsage: null,
    error:
      completed.status === "failed"
        ? {
            message: completed.stderr?.trim() || "Harness run failed.",
            kind: "harness_failed",
          }
        : null,
    codingRunId: completed.id,
  };
}

function stripHarnessPrefix(modelId: string, harnessId: HarnessId): string {
  if (harnessId === "codex_cli" && modelId.startsWith("codex:")) {
    return modelId.slice("codex:".length);
  }
  if (harnessId === "minimax_cli" && modelId.startsWith("minimax:")) {
    return modelId.slice("minimax:".length);
  }
  return modelId;
}

/**
 * Parse `git status --short` output into a list of changed-file paths.
 * Each line looks like " M path/to/file" or "M  path/to/file" or
 * "?? path/to/new"; we strip the leading status code and trim.
 */
function parseGitStatusShort(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, "").trim();
    if (!line) continue;
    // git status --short puts a 2-char XY status at the start, then a
    // space, then the path. For renames/copies, the path includes an
    // arrow "old -> new" — we keep the literal string so the user
    // can see both sides.
    const m = line.match(/^.{2,3}\s+(.+)$/);
    if (m && m[1]) out.push(m[1].trim());
    else out.push(line);
  }
  return out;
}
