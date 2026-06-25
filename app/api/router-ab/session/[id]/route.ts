import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { getAbSession } from "@/lib/repo/router-ab";
import { getAbFeedback } from "@/lib/repo/router-ab";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/router-ab/session/[id]
 *
 * Returns the session row + current feedback rating, used by the side-by-side
 * panel to re-hydrate after a page reload (the live SSE stream is gone).
 *
 *   200 { session, feedback }     session found
 *   200 { session: null }        DB not configured
 *   404 { error: "not_found" }   bad id or session does not exist
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "not_found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!isDbConfigured()) {
    return NextResponse.json(
      { session: null, configured: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const session = await getAbSession(id);
    if (!session) {
      return NextResponse.json(
        { error: "not_found" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    const feedback = await getAbFeedback(id);
    return NextResponse.json(
      { session, feedback: feedback?.rating ?? null, configured: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err: unknown) {
    console.error(
      "[api/router-ab/session GET] db error:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      { error: "db_error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
