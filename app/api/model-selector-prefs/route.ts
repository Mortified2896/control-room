import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { getSelectorPreferences, setSelectorPreferences } from "@/lib/repo/model-selector-prefs";

export const dynamic = "force-dynamic";

type ErrorBody = {
  error: string;
  errors?: ReadonlyArray<{ field: string; message: string }>;
  reason?: string;
};

/**
 * GET /api/model-selector-prefs
 *
 * Returns the current selector preferences object
 * (modelId -> { visible }). Empty object when the DB is unconfigured
 * or no row has been written yet.
 */
export async function GET() {
  if (!isDbConfigured()) {
    return NextResponse.json(
      { preferences: {}, configured: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const preferences = await getSelectorPreferences();
  return NextResponse.json(
    {
      preferences: Object.fromEntries(
        Object.entries(preferences).map(([k, v]) => [k, { visible: v.visible }]),
      ),
      configured: true,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * PUT /api/model-selector-prefs
 *
 * Body: { preferences: { "<modelId>": { visible: boolean } } }
 *
 * Validates the shape and writes the singleton row. Returns per-field
 * errors for invalid payloads.
 *
 * Responses:
 *   200 { preferences, configured: true }
 *   400 { error: "invalid_body", errors: [...] }
 *   503 { error: "db_not_configured" }
 */
export async function PUT(req: Request) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "db_not_configured" } satisfies ErrorBody, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_body", reason: "request body must be JSON" } satisfies ErrorBody,
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "invalid_body", reason: "body must be a JSON object" } satisfies ErrorBody,
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const b = body as Record<string, unknown>;
  const rawPreferences = b.preferences;
  if (rawPreferences === undefined) {
    return NextResponse.json(
      {
        error: "invalid_body",
        reason: "body.preferences is required",
      } satisfies ErrorBody,
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const result = await setSelectorPreferences({
      preferences: rawPreferences,
      updatedBy: "settings-ui",
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: "invalid_body", errors: result.errors } satisfies ErrorBody,
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      {
        preferences: Object.fromEntries(
          Object.entries(result.value).map(([k, v]) => [k, { visible: v.visible }]),
        ),
        configured: true,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[api/model-selector-prefs PUT] db error:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "db_error" } satisfies ErrorBody, {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
