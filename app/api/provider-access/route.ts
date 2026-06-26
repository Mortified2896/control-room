import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import {
  getProviderAccessSettings,
  stableProviderId,
  updateProviderAccessSettings,
} from "@/lib/providers/access-control";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { providers: await getProviderAccessSettings(), configured: isDbConfigured() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(req: Request) {
  if (!isDbConfigured())
    return NextResponse.json(
      { error: "db_not_configured" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const providers = Array.isArray((body as { providers?: unknown })?.providers)
    ? (body as { providers: unknown[] }).providers
    : null;
  if (!providers) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  try {
    const patch = providers.map((p) => {
      const r = p as Record<string, unknown>;
      return {
        provider_id: stableProviderId(String(r.provider_id)),
        enabled: Boolean(r.enabled),
        allow_manual: Boolean(r.allow_manual),
        allow_router: Boolean(r.allow_router),
        allow_backend_test: Boolean(r.allow_backend_test),
      };
    });
    await updateProviderAccessSettings(patch);
    return NextResponse.json(
      { providers: await getProviderAccessSettings() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "invalid_body" },
      { status: 400 },
    );
  }
}
