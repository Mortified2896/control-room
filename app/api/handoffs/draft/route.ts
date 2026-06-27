import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import {
  createHandoffDraft,
  isHandoffTaskType,
  isHandoffWorker,
} from "@/lib/repo/handoffs";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "db_not_configured" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (body == null || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const projectId = typeof b.projectId === "string" ? b.projectId : null;
  const threadId = typeof b.threadId === "string" && b.threadId.length > 0 ? b.threadId : null;
  const instruction = typeof b.instruction === "string" ? b.instruction.trim() : "";

  if (!projectId) return NextResponse.json({ error: "project_required" }, { status: 400 });
  if (!isHandoffWorker(b.worker)) {
    return NextResponse.json({ error: "invalid_worker" }, { status: 400 });
  }
  if (!isHandoffTaskType(b.taskType)) {
    return NextResponse.json({ error: "invalid_task_type" }, { status: 400 });
  }
  if (!instruction) return NextResponse.json({ error: "instruction_required" }, { status: 400 });

  const draft = await createHandoffDraft({
    projectId,
    threadId,
    worker: b.worker,
    taskType: b.taskType,
    instruction,
  });
  if (!draft) return NextResponse.json({ error: "project_not_found" }, { status: 404 });

  return NextResponse.json({ draft }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
