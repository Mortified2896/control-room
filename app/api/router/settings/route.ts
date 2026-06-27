import { NextResponse } from "next/server";
import { GET as getRouterSettings, PUT as putRouterSettings } from "@/app/api/router-settings/route";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const res = await getRouterSettings();
  if (!res.ok) return res;
  const data = await res.json();
  return NextResponse.json(
    {
      normalChatRouterProvider: "openai",
      normalChatRouterModelId: data.effective?.routerModelId ?? data.defaults?.routerModelId,
      defaults: {
        normalChatRouterProvider: "openai",
        normalChatRouterModelId: data.defaults?.routerModelId,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PATCH(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "invalid_body", reason: "payload must be a JSON object" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const modelId = body.normalChatRouterModelId ?? body.routerModelId;
  if (typeof modelId !== "string" || modelId.trim().length === 0) {
    return NextResponse.json(
      { error: "invalid_body", reason: "normalChatRouterModelId must be a non-empty string" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  return putRouterSettings(
    new Request(req.url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routerModelId: modelId.trim() }),
    }),
  );
}
