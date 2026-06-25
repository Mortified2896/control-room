import { getEffectiveModelsResponse } from "@/lib/providers/registry";

export const dynamic = "force-dynamic";

/**
 * GET /api/models
 *
 * Returns the `ModelsResponse` shape consumed by `app/assistant.tsx` and
 * the chat route's model picker. The payload is built from the
 * `EffectiveRegistry` (see `lib/providers/registry.ts`), filtered to the
 * `manualSelectorVisible` subset, so:
 *   - hidden models never appear in the chat composer dropdown,
 *   - unknown discovered models are hidden by default,
 *   - stale / unavailable models are hidden from the picker.
 *
 * When the DB is unconfigured (or discovery never ran), the registry
 * falls back to the local static catalog, so the chat composer still
 * works offline. This preserves the pre-discovery API contract exactly.
 */
export async function GET() {
  const payload = await getEffectiveModelsResponse();
  return Response.json(payload, {
    headers: { "Cache-Control": "no-store" },
  });
}
