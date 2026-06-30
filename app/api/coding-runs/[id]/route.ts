import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { getCodingRun } from "@/lib/repo/coding-runs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "database_not_configured" }, { status: 503 });
  }
  const { id } = await params;
  const run = await getCodingRun(id);
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ run }, { headers: { "Cache-Control": "no-store" } });
}
