import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { createEpisode, listEpisodes } from "@/lib/repo/create-room";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "no-store" };

export async function GET() {
  if (!isDbConfigured())
    return NextResponse.json({ episodes: [], configured: false }, { headers: noStore });
  return NextResponse.json(
    { episodes: await listEpisodes(), configured: true },
    { headers: noStore },
  );
}

export async function POST(req: Request) {
  if (!isDbConfigured())
    return NextResponse.json({ error: "db_not_configured" }, { status: 503, headers: noStore });
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* optional body */
  }
  const workingTitle = typeof body.workingTitle === "string" ? body.workingTitle : null;
  const modelId = typeof body.modelId === "string" ? body.modelId : null;
  try {
    return NextResponse.json(
      { episode: await createEpisode({ workingTitle, modelId }) },
      { status: 201, headers: noStore },
    );
  } catch (error) {
    console.error("[create-room episodes POST]", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "db_error" }, { status: 500, headers: noStore });
  }
}
