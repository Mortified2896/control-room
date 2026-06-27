import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { listProjects } from "@/lib/repo/projects";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isDbConfigured()) {
    return NextResponse.json({ projects: [], configured: false }, { headers: { "Cache-Control": "no-store" } });
  }
  const projects = await listProjects();
  return NextResponse.json({ projects, configured: true }, { headers: { "Cache-Control": "no-store" } });
}
