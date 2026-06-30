import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { createCodingRun } from "@/lib/repo/coding-runs";
import { createMessage, getThread } from "@/lib/repo/threads";
import { getProject } from "@/lib/repo/projects";
import { runProjectCodexRun } from "@/lib/codex/project-runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function textPart(text: string) {
  return [{ type: "text", text }];
}

function renderRunResult(run: Awaited<ReturnType<typeof runProjectCodexRun>>): string {
  const blocks = [
    `Codex CLI run ${run.status}.`,
    `Exit code: ${run.exitCode ?? "none"}`,
  ];
  if (run.stdout.trim()) blocks.push(`Stdout:\n\n${run.stdout.trim()}`);
  if (run.stderr.trim()) blocks.push(`Stderr:\n\n${run.stderr.trim()}`);
  if (run.gitStatusShort.trim()) blocks.push(`Changed files (git status --short):\n\n${run.gitStatusShort.trim()}`);
  if (run.gitDiffStat.trim()) blocks.push(`Diff summary (git diff --stat):\n\n${run.gitDiffStat.trim()}`);
  return blocks.join("\n\n");
}

export async function POST(req: NextRequest) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "database_not_configured" }, { status: 503 });
  }

  let body: { projectId?: unknown; threadId?: unknown; prompt?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const projectId = typeof body.projectId === "string" ? body.projectId : null;
  const threadId = typeof body.threadId === "string" ? body.threadId : null;
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!projectId) {
    return NextResponse.json(
      { error: "no_project_selected", message: "No project is selected. Select a project before running Codex CLI." },
      { status: 400 },
    );
  }
  if (!prompt) return NextResponse.json({ error: "empty_prompt" }, { status: 400 });

  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });

  if (threadId) {
    const thread = await getThread(threadId);
    if (!thread) return NextResponse.json({ error: "thread_not_found" }, { status: 404 });
    if (thread.projectId !== projectId) {
      return NextResponse.json({ error: "thread_project_mismatch" }, { status: 400 });
    }
  }

  const run = await createCodingRun({ projectId, threadId, prompt });
  if (threadId) {
    await createMessage({ threadId, role: "user", content: prompt, parts: textPart(prompt), modelId: "codex-cli" });
  }

  const completed = await runProjectCodexRun(run);
  if (threadId) {
    const text = renderRunResult(completed);
    await createMessage({ threadId, role: "assistant", content: text, parts: textPart(text), modelId: "codex-cli" });
  }

  const status = completed.status === "succeeded" ? 200 : 502;
  return NextResponse.json({ run: completed, project: { ...project, repoPath: project.repoPath } }, { status });
}
