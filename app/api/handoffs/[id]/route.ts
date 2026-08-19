import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { isHandoffStatus, updateHandoffDraft } from "@/lib/repo/handoffs";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "db_not_configured" }, { status: 503 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (body == null || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const prompt = typeof b.prompt === "string" ? b.prompt : undefined;
  const status = b.status === undefined ? undefined : b.status;
  if (status !== undefined && !isHandoffStatus(status)) {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }
  if (prompt === undefined && status === undefined) {
    return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
  }

  const draft = await updateHandoffDraft({ id, prompt, status });
  if (!draft) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ draft }, { headers: { "Cache-Control": "no-store" } });
}
