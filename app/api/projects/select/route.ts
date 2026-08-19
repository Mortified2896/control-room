import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { getProject } from "@/lib/repo/projects";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!isDbConfigured())
    return NextResponse.json({ error: "database_not_configured" }, { status: 503 });
  const body = (await req.json().catch(() => null)) as { projectId?: unknown } | null;
  const projectId = typeof body?.projectId === "string" ? body.projectId : null;
  if (!projectId) return NextResponse.json({ error: "no_project_selected" }, { status: 400 });
  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
  const res = NextResponse.json({ project });
  res.cookies.set("control_room_project_id", project.id, { sameSite: "lax", path: "/" });
  return res;
}
