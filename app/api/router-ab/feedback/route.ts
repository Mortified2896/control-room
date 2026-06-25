import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { AB_FEEDBACK_RATINGS, type AbFeedbackRating } from "@/lib/repo/types";
import { setAbFeedback, getAbFeedback } from "@/lib/repo/router-ab";

export const dynamic = "force-dynamic";

/**
 * GET /api/router-ab/feedback?sessionId=...
 *
 * Returns the current feedback rating for the session, or null if none.
 * Used by the panel on re-hydration so a refresh shows the user's last
 * click.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId || typeof sessionId !== "string") {
    return NextResponse.json(
      { error: "invalid_body", reason: "sessionId query param is required" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!isDbConfigured()) {
    return NextResponse.json(
      { rating: null, configured: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const row = await getAbFeedback(sessionId);
    return NextResponse.json(
      { rating: row?.rating ?? null, configured: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err: unknown) {
    console.error(
      "[api/router-ab/feedback GET] db error:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      { error: "db_error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

/**
 * PUT /api/router-ab/feedback
 *
 * Body: { "abSessionId": "uuid", "rating": "prefer_a" | "prefer_b" | "tie" | "bad_router" }
 *
 * Upserts the feedback row for the session. Each (session, rating) click is
 * idempotent; clicking the same rating twice keeps the rating in place
 * (no toggle in MVP — clicks are explicit votes).
 */
export async function PUT(req: Request) {
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
  const abSessionIdRaw = b.abSessionId;
  const ratingRaw = b.rating;
  if (typeof abSessionIdRaw !== "string" || abSessionIdRaw.trim().length === 0) {
    return NextResponse.json(
      { error: "invalid_body", reason: "abSessionId is required" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const abSessionId = abSessionIdRaw.trim();
  if (
    typeof ratingRaw !== "string" ||
    !(AB_FEEDBACK_RATINGS as ReadonlyArray<string>).includes(ratingRaw)
  ) {
    return NextResponse.json(
      {
        error: "invalid_body",
        reason: `rating must be one of: ${AB_FEEDBACK_RATINGS.join(", ")}`,
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const rating = ratingRaw as AbFeedbackRating;

  try {
    const row = await setAbFeedback({ abSessionId, rating });
    return NextResponse.json({ rating: row.rating }, { headers: { "Cache-Control": "no-store" } });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbSessionNotFoundError") {
      return NextResponse.json(
        { error: "ab_session_not_found" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    console.error(
      "[api/router-ab/feedback PUT] db error:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      { error: "db_error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
