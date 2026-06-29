import { NextResponse } from "next/server";
import {
  GET as getRouterSettings,
  PUT as putRouterSettings,
} from "@/app/api/router-settings/route";

export const dynamic = "force-dynamic";

/**
 * Thin wrapper over the canonical `/api/router-settings` endpoint that
 * exposes just the settings the chat composer needs without pulling in
 * the full Settings DTO (registry, prompts, etc.). Two routes exist on
 * purpose:
 *
 *   - `GET /api/router-settings`            → the full Settings UI DTO
 *     (effective settings + defaults + the unified registry, etc.)
 *     consumed by `components/settings/router-settings-page.tsx`.
 *   - `GET /api/router/settings`            → this endpoint, returns
 *     the lightweight subset that the chat composer needs to render
 *     its A/B and recommender controls. Used by the chat composer
 *     because pulling the full registry into the chat bundle is
 *     overkill for two dropdowns.
 *
 * The Settings UI does not call this endpoint; consolidation would
 * require teaching the lightweight clients to parse the larger DTO
 * for two fields. Keeping the wrapper means the underlying validation
 * pipeline (`parseRouterSettingsForSave` in `lib/router/schema.ts`)
 * stays the single source of truth for "what model ids may the router
 * call" — see that file for the OpenAI-only / static-alias policy that
 * fixes the persisted-settings validation warning.
 */

type RecommenderModelOptionDto = {
  modelId: string;
  displayLabel: string;
  providerLabel: string;
  providerId: "openai" | "codex" | "minimax" | string;
  reasoningCapability: import("@/lib/providers/capability").ReasoningCapability;
};

export async function GET(_req: Request) {
  const res = await getRouterSettings();
  if (!res.ok) return res;
  const data = await res.json();

  // The recommender options come from the unified registry (OpenAI API
  // rows) plus the static Codex catalog rows and the discovered MiniMax
  // rows. The order is intentionally: cheap visible first, then codex,
  // then minimax — mirroring the Settings page ordering.
  const registryModels = (data.effectiveRegistry?.models ?? []) as ReadonlyArray<{
    providerId: string;
    providerLabel: string;
    modelId: string;
    displayLabel: string;
    configured?: boolean;
    reasoningCapability: import("@/lib/providers/capability").ReasoningCapability;
  }>;
  const openaiOptions: RecommenderModelOptionDto[] = registryModels
    .filter((m) => m.providerId === "openai" && (m.configured ?? false))
    .map((m) => ({
      modelId: m.modelId,
      displayLabel: m.displayLabel,
      providerLabel: m.providerLabel,
      providerId: m.providerId,
      reasoningCapability: m.reasoningCapability,
    }));
  const codexOptions: RecommenderModelOptionDto[] = (data.effectiveRegistry?.models ?? [])
    .filter((m: { providerId: string }) => m.providerId === "codex")
    .map(
      (m: {
        modelId: string;
        displayLabel: string;
        providerLabel: string;
        providerId: string;
        reasoningCapability: import("@/lib/providers/capability").ReasoningCapability;
      }) => ({
        modelId: m.modelId,
        displayLabel: m.displayLabel,
        providerLabel: m.providerLabel,
        providerId: m.providerId,
        reasoningCapability: m.reasoningCapability,
      }),
    );
  const minimaxOptions: RecommenderModelOptionDto[] = registryModels
    .filter((m) => m.providerId === "minimax")
    .map((m) => ({
      modelId: m.modelId,
      displayLabel: m.displayLabel,
      providerLabel: m.providerLabel,
      providerId: m.providerId,
      reasoningCapability: m.reasoningCapability,
    }));

  const recommenderModelOptions: RecommenderModelOptionDto[] = [
    ...openaiOptions,
    ...codexOptions,
    ...minimaxOptions,
  ].sort((a, b) => a.displayLabel.localeCompare(b.displayLabel));

  return NextResponse.json(
    {
      normalChatRouterProvider: "openai",
      normalChatRouterModelId: data.effective?.routerModelId ?? data.defaults?.routerModelId,
      normalChatRecommenderModelId:
        data.effective?.normalChatRecommenderModelId ?? data.defaults?.normalChatRecommenderModelId,
      normalChatRecommenderReasoningLevel:
        data.effective?.normalChatRecommenderReasoningLevel ??
        data.defaults?.normalChatRecommenderReasoningLevel ??
        "low",
      normalChatRecommenderFallbackModelId:
        data.effective?.normalChatRecommenderFallbackModelId ??
        data.defaults?.normalChatRecommenderFallbackModelId ??
        null,
      normalChatRecommenderFallbackReasoningLevel:
        data.effective?.normalChatRecommenderFallbackReasoningLevel ??
        data.defaults?.normalChatRecommenderFallbackReasoningLevel ??
        null,
      recommenderModelOptions,
      defaults: {
        normalChatRouterProvider: "openai",
        normalChatRouterModelId: data.defaults?.routerModelId,
        normalChatRecommenderModelId: data.defaults?.normalChatRecommenderModelId,
        normalChatRecommenderReasoningLevel:
          data.defaults?.normalChatRecommenderReasoningLevel ?? "low",
        normalChatRecommenderFallbackModelId:
          data.defaults?.normalChatRecommenderFallbackModelId ?? null,
        normalChatRecommenderFallbackReasoningLevel:
          data.defaults?.normalChatRecommenderFallbackReasoningLevel ?? null,
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
  // `updates` carries whatever field the client wants to change. We
  // forward string scalars directly and validate the non-scalar fields
  // (the recommender allowlist) before letting them through to the
  // canonical PUT (which runs `parseRouterSettingsForSave`).
  const updates: Record<string, unknown> = {};
  const routerModelId = body.normalChatRouterModelId ?? body.routerModelId;
  if (typeof routerModelId === "string" && routerModelId.trim().length > 0) {
    updates.routerModelId = routerModelId.trim();
  }
  const recommenderModelId = body.normalChatRecommenderModelId;
  if (typeof recommenderModelId === "string" && recommenderModelId.trim().length > 0) {
    updates.normalChatRecommenderModelId = recommenderModelId.trim();
  }
  const recommenderReasoningLevel = body.normalChatRecommenderReasoningLevel;
  if (
    typeof recommenderReasoningLevel === "string" &&
    recommenderReasoningLevel.trim().length > 0
  ) {
    updates.normalChatRecommenderReasoningLevel = recommenderReasoningLevel.trim();
  }
  if ("normalChatRecommenderFallbackModelId" in body) {
    const fallbackModelId = body.normalChatRecommenderFallbackModelId;
    if (fallbackModelId === null) {
      updates.normalChatRecommenderFallbackModelId = null;
    } else if (typeof fallbackModelId === "string" && fallbackModelId.trim().length > 0) {
      updates.normalChatRecommenderFallbackModelId = fallbackModelId.trim();
    } else {
      return NextResponse.json(
        {
          error: "invalid_body",
          reason: "normalChatRecommenderFallbackModelId must be null or a non-empty string",
        },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
  }
  if ("normalChatRecommenderFallbackReasoningLevel" in body) {
    const fallbackReasoningLevel = body.normalChatRecommenderFallbackReasoningLevel;
    if (fallbackReasoningLevel === null) {
      updates.normalChatRecommenderFallbackReasoningLevel = null;
    } else if (
      typeof fallbackReasoningLevel === "string" &&
      fallbackReasoningLevel.trim().length > 0
    ) {
      updates.normalChatRecommenderFallbackReasoningLevel = fallbackReasoningLevel.trim();
    } else {
      return NextResponse.json(
        {
          error: "invalid_body",
          reason: "normalChatRecommenderFallbackReasoningLevel must be null or a non-empty string",
        },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
  }
  if ("normalChatRecommenderAllowedModels" in body) {
    const allowlist = body.normalChatRecommenderAllowedModels;
    if (allowlist === null) {
      // `null` explicitly = "no restriction" (default).
      updates.normalChatRecommenderAllowedModels = null;
    } else if (!Array.isArray(allowlist)) {
      return NextResponse.json(
        {
          error: "invalid_body",
          reason: "normalChatRecommenderAllowedModels must be null or an array of strings",
        },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    } else {
      const cleaned: string[] = [];
      for (const entry of allowlist) {
        if (typeof entry !== "string" || entry.trim().length === 0) {
          return NextResponse.json(
            {
              error: "invalid_body",
              reason: "normalChatRecommenderAllowedModels entries must be non-empty strings",
            },
            { status: 400, headers: { "Cache-Control": "no-store" } },
          );
        }
        const trimmed = entry.trim();
        if (!cleaned.includes(trimmed)) cleaned.push(trimmed);
      }
      updates.normalChatRecommenderAllowedModels = cleaned;
    }
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      {
        error: "invalid_body",
        reason:
          "at least one of normalChatRouterModelId, normalChatRecommenderModelId, normalChatRecommenderReasoningLevel, normalChatRecommenderFallbackModelId, normalChatRecommenderFallbackReasoningLevel, or normalChatRecommenderAllowedModels must be provided",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  return putRouterSettings(
    new Request(req.url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    }),
  );
}
