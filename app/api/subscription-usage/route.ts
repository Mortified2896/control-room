import { NextResponse } from "next/server";

import {
  fetchMiniMaxSubscriptionUsage,
  type SubscriptionUsageStatus,
} from "@/lib/minimax/subscription-usage";

export const dynamic = "force-dynamic";

/**
 * GET /api/subscription-usage
 *
 * Returns normalized subscription usage statuses for all supported
 * subscription-backed providers.
 *
 * Currently only MiniMax is implemented. Each provider status includes
 * `ok: true` with usage details or `ok: false` with a clear error
 * object. The route always returns HTTP 200 unless the server itself
 * crashes — individual provider failures are encoded in their status
 * objects.
 *
 * The response never contains API keys, tokens, or secrets.
 */
export async function GET(): Promise<
  NextResponse<{ statuses: SubscriptionUsageStatus[] }>
> {
  const minimaxStatus = await fetchMiniMaxSubscriptionUsage();

  return NextResponse.json(
    { statuses: [minimaxStatus] },
    { headers: { "Cache-Control": "no-store" } },
  );
}
