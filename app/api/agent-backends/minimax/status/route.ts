import { NextResponse } from "next/server";
import { probeMiniMaxStatus, type MiniMaxStatusDto } from "@/lib/minimax/status";

export const dynamic = "force-dynamic";

/**
 * GET /api/agent-backends/minimax/status
 *
 * Read-only probe of the MiniMax CLI on this server. Invokes at most:
 *   - `mmx --version`
 *   - `mmx quota`
 *   - `mmx config get region`
 *
 * The response is `200` always. A missing CLI, missing auth, or
 * probe failure is encoded in the `status` and `errorMessage` fields
 * — we never `500` because the absence of MiniMax is a normal state,
 * not a server outage.
 *
 * Cache-Control: no-store so the dashboard always sees fresh state.
 */
export async function GET(): Promise<NextResponse<MiniMaxStatusDto>> {
  const dto = await probeMiniMaxStatus();
  return NextResponse.json(dto, { headers: { "Cache-Control": "no-store" } });
}
