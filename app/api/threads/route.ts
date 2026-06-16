import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { listThreads } from "@/lib/repo/threads";

export const dynamic = "force-dynamic";

/**
 * GET /api/threads
 *
 * Returns the persisted thread list, newest activity first. When the DB is
 * not configured (or unreachable), returns an empty list with a 200 so the
 * client falls back to the in-memory `INITIAL_THREADS` list. We deliberately
 * do not 5xx on a missing DB: the in-memory fallback is the source of truth
 * for the UI in Milestone 1.
 */
export async function GET() {
  if (!isDbConfigured()) {
    return NextResponse.json(
      { threads: [], configured: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const threads = await listThreads();
  return NextResponse.json(
    { threads, configured: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
