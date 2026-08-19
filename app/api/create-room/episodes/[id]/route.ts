import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { getEpisode } from "@/lib/repo/create-room";

export const dynamic = "force-dynamic";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isDbConfigured()) return NextResponse.json({ episode: null, configured: false });
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "episode_not_found" }, { status: 404 });
  const episode = await getEpisode(id);
  return episode
    ? NextResponse.json({ episode, configured: true })
    : NextResponse.json({ error: "episode_not_found" }, { status: 404 });
}
