import "server-only";

import { withClient } from "@/lib/db";
import type { CodingRunRow, CodingRunStatus } from "./types";

type RawCodingRun = {
  id: string;
  project_id: string;
  thread_id: string | null;
  prompt: string;
  executor: string;
  status: CodingRunStatus;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  git_status_short: string;
  git_diff_stat: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
};

const COLUMNS =
  "id, project_id, thread_id, prompt, executor, status, stdout, stderr, exit_code, git_status_short, git_diff_stat, created_at, started_at, finished_at";

function toCodingRunRow(r: RawCodingRun): CodingRunRow {
  return {
    id: r.id,
    projectId: r.project_id,
    threadId: r.thread_id,
    prompt: r.prompt,
    executor: r.executor,
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.exit_code,
    gitStatusShort: r.git_status_short,
    gitDiffStat: r.git_diff_stat,
    createdAt: r.created_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

export async function createCodingRun(input: {
  projectId: string;
  threadId?: string | null;
  prompt: string;
  executor?: string;
}): Promise<CodingRunRow> {
  return withClient(async (c) => {
    const { rows } = await c.query<RawCodingRun>(
      `INSERT INTO coding_runs (project_id, thread_id, prompt, executor)
       VALUES ($1, $2, $3, $4)
       RETURNING ${COLUMNS}`,
      [input.projectId, input.threadId ?? null, input.prompt, input.executor ?? "codex-cli"],
    );
    return toCodingRunRow(rows[0]);
  });
}

export async function getCodingRun(id: string): Promise<CodingRunRow | null> {
  return withClient(async (c) => {
    const { rows } = await c.query<RawCodingRun>(
      `SELECT ${COLUMNS} FROM coding_runs WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ? toCodingRunRow(rows[0]) : null;
  });
}

export async function markCodingRunRunning(id: string): Promise<void> {
  await withClient((c) =>
    c.query("UPDATE coding_runs SET status = 'running', started_at = now() WHERE id = $1", [id]),
  );
}

export async function finishCodingRun(input: {
  id: string;
  status: Extract<CodingRunStatus, "succeeded" | "failed">;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  gitStatusShort?: string;
  gitDiffStat?: string;
}): Promise<CodingRunRow> {
  return withClient(async (c) => {
    const { rows } = await c.query<RawCodingRun>(
      `UPDATE coding_runs
       SET status = $2,
           stdout = $3,
           stderr = $4,
           exit_code = $5,
           git_status_short = $6,
           git_diff_stat = $7,
           finished_at = now()
       WHERE id = $1
       RETURNING ${COLUMNS}`,
      [
        input.id,
        input.status,
        input.stdout,
        input.stderr,
        input.exitCode,
        input.gitStatusShort ?? "",
        input.gitDiffStat ?? "",
      ],
    );
    return toCodingRunRow(rows[0]);
  });
}
