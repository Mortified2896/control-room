import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { createThread, listThreads } from "@/lib/repo/threads";

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

/**
 * POST /api/threads
 *
 * Body: { "title": "New chat", "modelId"?: "gpt-5.5" }
 *   - `title` is required (non-empty after trim).
 *   - `modelId` is optional, stored as-is.
 *
 * Responses:
 *   201 { thread }                                  created
 *   400 { error: "invalid_body", reason: string }   missing/empty title
 *   503 { error: "db_not_configured" }              env unset
 *   500 { error: "db_error", reason: string }       unexpected DB error
 */
export async function POST(req: Request) {
  if (!isDbConfigured()) {
    return NextResponse.json(
      { error: "db_not_configured" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_body", reason: "request body must be JSON" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (body == null || typeof body !== "object") {
    return NextResponse.json(
      { error: "invalid_body", reason: "body must be a JSON object" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const b = body as Record<string, unknown>;
  const titleRaw = b.title;
  if (typeof titleRaw !== "string" || titleRaw.trim().length === 0) {
    return NextResponse.json(
      { error: "invalid_body", reason: "title is required and must be a non-empty string" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const modelIdRaw = b.modelId;
  const modelId =
    modelIdRaw == null
      ? null
      : typeof modelIdRaw === "string" && modelIdRaw.trim().length > 0
        ? modelIdRaw
        : null;

  try {
    const thread = await createThread({ title: titleRaw.trim(), modelId });
    return NextResponse.json({ thread }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[api/threads POST] db error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "db_error", reason: "could not create thread" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
