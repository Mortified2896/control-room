import { NextResponse } from "next/server";

import { probeCodexStatus, type CodexStatusDto } from "@/lib/codex/status";

export const dynamic = "force-dynamic";

/**
 * GET /api/agent-backends/codex/status
 *
 * Read-only probe of the Codex CLI on this server. Invokes at most:
 *   - `codex --version`
 *   - `codex login status`
 * and optionally inspects the top-level shape of `~/.codex/auth.json`
 * (never reads values, never logs contents).
 *
 * The response is `200` always. A missing CLI, a missing login, or a
 * probe failure is encoded in the `status` and `errorMessage` fields
 * — we never `500` because the absence of Codex is a normal state,
 * not a server outage.
 *
 * Cache-Control: no-store so the dashboard always sees fresh state.
 */
export async function GET(): Promise<NextResponse<CodexStatusDto>> {
  const dto = await probeCodexStatus();
  return NextResponse.json(dto, { headers: { "Cache-Control": "no-store" } });
}
