import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { isMessageRating } from "@/lib/repo/feedback-helpers";
import { getMessageRating, setOrToggleMessageRating } from "@/lib/repo/feedback";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isDbConfigured()) {
    return NextResponse.json(
      { rating: null, configured: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "message_not_found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const rating = await getMessageRating(id);
    return NextResponse.json(
      { rating, configured: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error(
      "[api/messages/[id]/feedback GET] db error:",
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
      { error: "message_not_found" },
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

  const rating =
    body && typeof body === "object" ? (body as Record<string, unknown>).rating : undefined;
  if (!isMessageRating(rating)) {
    return NextResponse.json(
      { error: "invalid_body", reason: "rating must be 'up' or 'down'" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const nextRating = await setOrToggleMessageRating({ messageId: id, rating });
    return NextResponse.json({ rating: nextRating }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof Error && err.name === "MessageNotFoundError") {
      return NextResponse.json(
        { error: "message_not_found" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (err instanceof Error && err.name === "InvalidFeedbackTargetError") {
      return NextResponse.json(
        { error: "invalid_feedback_target" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    console.error(
      "[api/messages/[id]/feedback PUT] db error:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      { error: "db_error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
