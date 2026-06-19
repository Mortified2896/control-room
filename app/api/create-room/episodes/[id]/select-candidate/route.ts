import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { selectCandidate } from "@/lib/repo/create-room";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isDbConfigured()) return NextResponse.json({ error: "db_not_configured" }, { status: 503 });
  let candidateId: unknown;
  try {
    ({ candidateId } = await req.json());
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (typeof candidateId !== "string")
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  try {
    return NextResponse.json(await selectCandidate({ episodeId: id, candidateId }));
  } catch (error) {
    if (error instanceof Error && error.message === "candidate_not_found")
      return NextResponse.json({ error: "candidate_not_found" }, { status: 404 });
    console.error(
      "[create-room select-candidate POST]",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }
}
