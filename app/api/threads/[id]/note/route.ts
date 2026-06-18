import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { getThreadNote, upsertThreadNote } from "@/lib/repo/feedback";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isDbConfigured()) {
    return NextResponse.json(
      { note: null, configured: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "thread_not_found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const note = await getThreadNote(id);
    return NextResponse.json(
      { note, configured: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error(
      "[api/threads/[id]/note GET] db error:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      { error: "db_error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isDbConfigured()) {
    return NextResponse.json(
      { error: "db_not_configured" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "thread_not_found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
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

  const noteBody =
    body && typeof body === "object" ? (body as Record<string, unknown>).body : undefined;
  if (typeof noteBody !== "string") {
    return NextResponse.json(
      { error: "invalid_body", reason: "body must be a string" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const note = await upsertThreadNote({ threadId: id, body: noteBody });
    return NextResponse.json({ note }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(
      "[api/threads/[id]/note PUT] db error:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      { error: "db_error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
