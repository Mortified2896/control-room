import { NextResponse } from "next/server";
import { isDbConfigured, tryDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Non-secret DB health probe.
 *
 * Response shape (always 200, so a missing DB does not look like a server
 * outage to a load balancer):
 *   { ok: boolean, configured: boolean, version?: string, error?: string }
 *
 * The full version string from Postgres is intentionally truncated to the
 * server name+version only (e.g. "PostgreSQL 15.18") -- the platform/build
 * details are not returned.
 */
export async function GET() {
  const configured = isDbConfigured();
  if (!configured) {
    return NextResponse.json({
      ok: false,
      configured: false,
      error: "CONTROL_ROOM_DATABASE_URL is not set",
    });
  }

  const result = await tryDb(async (c) => {
    const r = await c.query<{ server_version: string }>("SHOW server_version");
    return r.rows[0]?.server_version ?? null;
  }, null);

  if (result == null) {
    return NextResponse.json({
      ok: false,
      configured: true,
      error: "DB unreachable",
    });
  }

  // Truncate to "MAJOR.MINOR" so the response does not leak build details.
  const short = result.split(" ")[0]?.split(".").slice(0, 2).join(".") ?? result;
  return NextResponse.json({ ok: true, configured: true, version: short });
}
