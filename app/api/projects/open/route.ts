import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { openProject } from "@/lib/repo/projects";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "db_not_configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body", reason: "request body must be JSON" }, { status: 400 });
  }
  const localPath = body && typeof body === "object" ? (body as Record<string, unknown>).localPath : null;
  if (typeof localPath !== "string" || localPath.trim().length === 0) {
    return NextResponse.json({ error: "invalid_body", reason: "localPath is required" }, { status: 400 });
  }
  try {
    const project = await openProject(localPath);
    return NextResponse.json({ project }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "db_error";
    const status = code === "missing" || code === "not_directory" || code === "outside_workspace" || code === "not_git_repo" ? 400 : 500;
    return NextResponse.json({ error: code, reason: code }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
