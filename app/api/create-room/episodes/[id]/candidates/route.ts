import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { getEpisode, listCandidates } from "@/lib/repo/create-room";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isDbConfigured()) return NextResponse.json({ candidates: [], configured: false });
  if (!(await getEpisode(id)))
    return NextResponse.json({ error: "episode_not_found" }, { status: 404 });
  return NextResponse.json(
    { candidates: await listCandidates(id), configured: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
