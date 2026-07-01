import { NextResponse } from "next/server";

import { getEffectiveCodingModelRoutingPolicy } from "@/lib/harness/model-routing";
import {
  DEFAULT_CODING_MODEL_ROUTING_SETTINGS,
  codingPolicyToSettings,
  listCodingRouteEligibleModelIds,
  parseCodingModelRoutingSettings,
  upsertCodingModelRoutingSettings,
} from "@/lib/repo/coding-model-routing-settings";
import { isDbConfigured } from "@/lib/db";
import { getEffectiveModelsResponse } from "@/lib/providers/registry";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const policy = await getEffectiveCodingModelRoutingPolicy();
  const modelsPayload = await getEffectiveModelsResponse().catch(() => null);
  const centralOptions = modelsPayload?.models
    .filter((m) => m.enabled && (m.supportedExecutionTargets ?? []).some((t) => t === "codex_cli" || t === "minimax_cli"))
    .map((m) => ({ id: m.modelId, label: m.modelLabel, reasoningLevels: m.reasoningLevels, billingLabel: m.billingLabel })) ?? [];
  return NextResponse.json({
    settings: codingPolicyToSettings(policy),
    defaults: DEFAULT_CODING_MODEL_ROUTING_SETTINGS,
    modelOptions: centralOptions.length > 0 ? centralOptions : listCodingRouteEligibleModelIds().map((id) => ({ id, label: id })),
    fallbackReasonOptions: [
      { id: "usage_limit", label: "Recent quota failure" },
      { id: "rate_limit", label: "Recent rate-limit failure" },
      { id: "internal", label: "Recent provider failure" },
    ],
    copy: {
      note: "Model routing selects a recommender lane only. The recommender engine chooses an execution model and reasoning level from central availability; unknown usage does not trigger silent fallback.",
    },
    configured: isDbConfigured(),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body", message: "Request body must be JSON." }, { status: 400 });
  }
  const validation = parseCodingModelRoutingSettings(body);
  if (!validation.ok) {
    return NextResponse.json({ error: "invalid_model_routing_settings", errors: validation.errors }, { status: 400 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "database_not_configured", message: "Cannot save model routing settings because CONTROL_ROOM_DATABASE_URL is not configured." }, { status: 503 });
  }
  const saved = await upsertCodingModelRoutingSettings({ settings: validation.value, updatedBy: "settings-ui" });
  if (!saved.ok) {
    return NextResponse.json({ error: "invalid_model_routing_settings", errors: saved.errors }, { status: 400 });
  }
  return NextResponse.json({ settings: saved.value }, { headers: { "Cache-Control": "no-store" } });
}
