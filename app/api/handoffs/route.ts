import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { listHandoffDrafts } from "@/lib/repo/handoffs";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request) {
  if (!isDbConfigured()) {
    return NextResponse.json(
      { drafts: [], configured: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const url = new URL(req.url);
  const threadId = url.searchParams.get("threadId");
  if (!threadId || !UUID_RE.test(threadId)) {
    return NextResponse.json({ error: "invalid_thread_id" }, { status: 400 });
  }

  const drafts = await listHandoffDrafts(threadId);
  return NextResponse.json(
    { drafts, configured: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
