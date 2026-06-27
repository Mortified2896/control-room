import "server-only";

import { withClient } from "@/lib/db";
import { getProject } from "./projects";
import { listMessages } from "./threads";
import type { MessageRow } from "./types";

export const HANDOFF_WORKERS = ["pi", "codex", "opencode"] as const;
export const HANDOFF_TASK_TYPES = ["implement", "debug", "inspect", "refactor", "test", "review"] as const;
export const HANDOFF_STATUSES = ["draft", "copied", "discarded"] as const;

export type HandoffWorker = (typeof HANDOFF_WORKERS)[number];
export type HandoffTaskType = (typeof HANDOFF_TASK_TYPES)[number];
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export type HandoffDraftRow = {
  id: string;
  projectId: string;
  threadId: string | null;
  sourceMessageId: string | null;
  worker: HandoffWorker;
  taskType: HandoffTaskType;
  title: string | null;
  prompt: string;
  status: HandoffStatus;
  createdAt: string;
  updatedAt: string;
};

type RawHandoffDraft = {
  id: string;
  project_id: string;
  thread_id: string | null;
  source_message_id: string | null;
  worker: HandoffWorker;
  task_type: HandoffTaskType;
  title: string | null;
  prompt: string;
  status: HandoffStatus;
  created_at: Date;
  updated_at: Date;
};

function toHandoffDraftRow(row: RawHandoffDraft): HandoffDraftRow {
  return {
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    sourceMessageId: row.source_message_id,
    worker: row.worker,
    taskType: row.task_type,
    title: row.title,
    prompt: row.prompt,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function isHandoffWorker(value: unknown): value is HandoffWorker {
  return typeof value === "string" && (HANDOFF_WORKERS as readonly string[]).includes(value);
}

export function isHandoffTaskType(value: unknown): value is HandoffTaskType {
  return typeof value === "string" && (HANDOFF_TASK_TYPES as readonly string[]).includes(value);
}

export function isHandoffStatus(value: unknown): value is HandoffStatus {
  return typeof value === "string" && (HANDOFF_STATUSES as readonly string[]).includes(value);
}

function workerLabel(worker: HandoffWorker): string {
  if (worker === "pi") return "Pi";
  if (worker === "codex") return "Codex";
  return "OpenCode";
}

function recentContext(messages: MessageRow[]): string {
  const text = messages
    .slice(-8)
    .map((m) => {
      const content = (m.content ?? "").trim();
      if (!content) return null;
      return `${m.role}: ${content.slice(0, 800)}`;
    })
    .filter((v): v is string => Boolean(v))
    .join("\n\n");
  return text || "No recent thread context available.";
}

export async function createHandoffDraft(input: {
  projectId: string;
  threadId?: string | null;
  worker: HandoffWorker;
  taskType: HandoffTaskType;
  instruction: string;
}): Promise<HandoffDraftRow | null> {
  const project = await getProject(input.projectId);
  if (!project) return null;

  const messages = input.threadId ? await listMessages(input.threadId) : [];
  const title = input.instruction.trim().split(/\s+/).slice(0, 8).join(" ");
  const prompt = `You are receiving a coding task from Control Room.

Worker: ${workerLabel(input.worker)}
Task type: ${input.taskType}

Project:
- Name: ${project.name}
- Path: ${project.localPath}
- Git remote: ${project.gitRemoteUrl ?? "none"}
- Branch at handoff: ${project.gitBranch ?? "unknown"}

MANDATORY PREFLIGHT:
Before making changes, run:
pwd
git rev-parse --show-toplevel
git branch --show-current
git status --short

The repo root must be exactly:
${project.localPath}

If the repo root does not match, stop and report the mismatch.

Task:
${input.instruction.trim()}

Context:
${recentContext(messages)}

Safety:
- Work only in the selected repo path.
- Do not touch unrelated repos.
- Inspect before editing.
- Do not restart the process that hosts your own active agent session.
- If you are running inside Control Room itself, do not restart Control Room mid-response.
- If you are running externally through Pi/OpenCode/Codex, Control Room may be restarted/deployed.
- Report changed files, validation commands, results, and caveats.`;

  return withClient(async (c) => {
    const { rows } = await c.query<RawHandoffDraft>(
      `INSERT INTO handoff_drafts (project_id, thread_id, worker, task_type, title, prompt)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, project_id, thread_id, source_message_id, worker, task_type, title, prompt, status, created_at, updated_at`,
      [project.id, input.threadId ?? null, input.worker, input.taskType, title || null, prompt],
    );
    return toHandoffDraftRow(rows[0]);
  });
}

export async function listHandoffDrafts(threadId: string): Promise<HandoffDraftRow[]> {
  return withClient(async (c) => {
    const { rows } = await c.query<RawHandoffDraft>(
      `SELECT id, project_id, thread_id, source_message_id, worker, task_type, title, prompt, status, created_at, updated_at
       FROM handoff_drafts
       WHERE thread_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [threadId],
    );
    return rows.map(toHandoffDraftRow);
  });
}

export async function updateHandoffDraft(input: {
  id: string;
  prompt?: string;
  status?: HandoffStatus;
}): Promise<HandoffDraftRow | null> {
  return withClient(async (c) => {
    const { rows } = await c.query<RawHandoffDraft>(
      `UPDATE handoff_drafts
       SET prompt = COALESCE($2, prompt), status = COALESCE($3, status)
       WHERE id = $1
       RETURNING id, project_id, thread_id, source_message_id, worker, task_type, title, prompt, status, created_at, updated_at`,
      [input.id, input.prompt ?? null, input.status ?? null],
    );
    return rows[0] ? toHandoffDraftRow(rows[0]) : null;
  });
}
