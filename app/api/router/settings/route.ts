import { NextResponse } from "next/server";
import { GET as getRouterSettings, PUT as putRouterSettings } from "@/app/api/router-settings/route";

export const dynamic = "force-dynamic";

/**
 * Thin wrapper over the canonical `/api/router-settings` endpoint that
 * exposes just the normal-chat router model id (and provider) on its
 * own. Two routes exist on purpose:
 *
 *   - `GET /api/router-settings`            → the full Settings UI DTO
 *     (effective settings + defaults + the unified registry, etc.)
 *     consumed by `components/settings/router-settings-page.tsx`.
 *   - `GET /api/router/settings`            → this endpoint, returns
 *     `{ normalChatRouterProvider, normalChatRouterModelId, defaults }`.
 *     Used by lightweight clients (e.g. the chat composer that wants
 *     to render the active normal-chat router model next to the model
 *     picker) that do not need the full DTO.
 *
 * The Settings UI does not call this endpoint; consolidation would
 * require teaching the lightweight clients to parse the larger DTO
 * for one field. Keeping the wrapper means the underlying validation
 * pipeline (`parseRouterSettingsForSave` in `lib/router/schema.ts`)
 * stays the single source of truth for "what model ids may the router
 * call" — see that file for the OpenAI-only / static-alias policy that
 * fixes the persisted-settings validation warning.
 */

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
