import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { getThread, listMessages } from "@/lib/repo/threads";

export const dynamic = "force-dynamic";

/**
 * GET /api/threads/[id]/messages
 *
 * Returns the message list for a thread (oldest first). Responds:
 *   200 { thread, messages }   -- thread found
 *   200 { thread: null, messages: [] } -- DB not configured
 *   404 { error: "thread_not_found" }  -- thread id does not exist
 *
 * Note: in Milestone 1, the messages table does not exist yet, so the
 * `messages` array will always be `[]`. That is the intended behaviour.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isDbConfigured()) {
    return NextResponse.json(
      { thread: null, messages: [], configured: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const thread = await getThread(id);
  if (!thread) {
    return NextResponse.json(
      { error: "thread_not_found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  const messages = await listMessages(id);
  return NextResponse.json(
    { thread, messages, configured: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
