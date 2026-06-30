import { NextResponse } from "next/server";
import { openai } from "@ai-sdk/openai";
import { jsonSchema } from "@ai-sdk/provider-utils";
import { generateText, Output } from "ai";

import { getEffectiveModelsResponse } from "@/lib/providers/registry";
import { ensureDiscoveryFresh } from "@/lib/providers/openai-discovery";
import {
  HARNESS_REGISTRY,
  probeHarnessStatuses,
  registryWithStatus,
  type HarnessId,
  type HarnessStatus,
  type HarnessStatusSnapshot,
} from "@/lib/harness/registry";
import { CODEX_CATALOG_MODELS } from "@/lib/providers/codex-catalog";

export const dynamic = "force-dynamic";

type CodingHarness = "codex_cli" | "minimax_cli";

type RecommendationTaskType = "coding" | "debugging" | "repo_edit" | "code_review" | "other";

type RecommendationResponse = {
  taskType: RecommendationTaskType;
  executionTarget: "coding_harness";
  recommendedHarness: CodingHarness;
  recommendedModelId: string;
  recommendedReasoningLevel: string;
  reason: string;
  requiresProjectFolder: true;
  requiresUserApproval: true;
  alternatives: Array<{
    harness: CodingHarness;
    modelId: string;
    reasoningLevel: string;
    reason: string;
  }>;
};

type FallbackResponse = {
  taskType: RecommendationTaskType;
  executionTarget: "coding_harness";
  recommendedHarness: CodingHarness;
  recommendedModelId: string;
  recommendedReasoningLevel: string;
  reason: string;
  requiresProjectFolder: true;
  requiresUserApproval: true;
  alternatives: Array<{
    harness: CodingHarness;
    modelId: string;
    reasoningLevel: string;
    reason: string;
  }>;
  fallback: true;
  fallbackReason: "model_not_listed" | "provider_call_failed" | "no_harness_available";
};

const HARNESS_RECOMMENDER_MODEL_ID = "gpt-5.4-mini" as const;

function isCodingHarness(value: unknown): value is CodingHarness {
  return value === "codex_cli" || value === "minimax_cli";
}

function pickDeterministicRecommendation(
  snapshots: ReadonlyArray<{
    id: HarnessId;
    status: HarnessStatus;
    unavailableReason: string | null;
  }>,
): { harness: CodingHarness; reason: string } {
  // Preference order:
  //   1. Codex CLI when available (ChatGPT subscription; well-known).
  //   2. MiniMax CLI when Codex is unavailable and MiniMax is available.
  //   3. Loud failure (no harness available) — UI must surface that
  //      and offer a manual choice. We never fall back to the normal
  //      chat path or to API billing.
  const codex = snapshots.find((s) => s.id === "codex_cli");
  const minimax = snapshots.find((s) => s.id === "minimax_cli");
  if (codex?.status === "available") {
    return {
      harness: "codex_cli",
      reason: "Codex CLI is available and is the preferred harness for coding tasks.",
    };
  }
  if (minimax?.status === "available") {
    return {
      harness: "minimax_cli",
      reason:
        "Codex CLI is unavailable; MiniMax CLI is available. Switch to MiniMax only after explicit user approval.",
    };
  }
  if (codex?.status === "unavailable" && minimax?.status === "unavailable") {
    // Both harnesses are down — loud failure. Caller picks the
    // harness with the better error message in the UI.
    return {
      harness: "codex_cli",
      reason:
        "Both coding harnesses are unavailable. Codex CLI: " +
        (codex.unavailableReason ?? "unknown") +
        ". MiniMax CLI: " +
        (minimax.unavailableReason ?? "unknown") +
        ". Ask the user to enable a harness in Settings or choose 'Answer in chat'.",
    };
  }
  // Last resort: prefer Codex, the operator-configured default.
  return {
    harness: "codex_cli",
    reason: "Defaulting to Codex CLI; no live harness status was available.",
  };
}

const schema = jsonSchema<RecommendationResponse>({
  type: "object",
  additionalProperties: false,
  required: [
    "taskType",
    "executionTarget",
    "recommendedHarness",
    "recommendedModelId",
    "recommendedReasoningLevel",
    "reason",
    "requiresProjectFolder",
    "requiresUserApproval",
    "alternatives",
  ],
  properties: {
    taskType: {
      type: "string",
      enum: ["coding", "debugging", "repo_edit", "code_review", "other"],
    },
    executionTarget: { type: "string", enum: ["coding_harness"] },
    recommendedHarness: { type: "string", enum: ["codex_cli", "minimax_cli"] },
    recommendedModelId: { type: "string", minLength: 1, maxLength: 200 },
    recommendedReasoningLevel: { type: "string", minLength: 1, maxLength: 50 },
    reason: { type: "string", minLength: 1, maxLength: 280 },
    requiresProjectFolder: { type: "boolean" },
    requiresUserApproval: { type: "boolean" },
    alternatives: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["harness", "modelId", "reasoningLevel", "reason"],
        properties: {
          harness: { type: "string", enum: ["codex_cli", "minimax_cli"] },
          modelId: { type: "string", minLength: 1, maxLength: 200 },
          reasoningLevel: { type: "string", minLength: 1, maxLength: 50 },
          reason: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
    },
  },
});

function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * Build the harness recommendation for a coding task. The
 * recommendation:
 *   1. Reads the live harness status (Codex + MiniMax probes).
 *   2. Builds the registry view.
 *   3. Asks the OpenAI router model for a structured pick between
 *      `codex_cli` and `minimax_cli` with a model + reasoning level
 *      drawn from the central catalog.
 *   4. Falls back to a deterministic preference order when the
 *      router call fails (Codex first, MiniMax second, loud
 *      failure last).
 *
 * IMPORTANT: this endpoint NEVER recommends the normal chat path
 * or any API-billed provider. If no harness is available the
 * response includes `fallback: true` with `fallbackReason` so the
 * UI can render a loud-failure state.
 */
export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (body == null || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const instruction = typeof b.instruction === "string" ? b.instruction.trim() : "";
  if (!instruction) return NextResponse.json({ error: "instruction_required" }, { status: 400 });

  // Probe both harnesses + read the central model catalog in
  // parallel so the router prompt has fresh data.
  const [snapshots, modelsResp] = await Promise.all([
    probeHarnessStatuses().catch(() => [] as HarnessStatusSnapshot[]),
    (async () => {
      await ensureDiscoveryFresh();
      return getEffectiveModelsResponse();
    })().catch(() => ({ models: [], defaultModelId: null, defaultReasoningLevel: "low" })),
  ]);
  const registry = registryWithStatus(snapshots);
  const snapshotById = new Map(snapshots.map((s) => [s.id, s] as const));

  // If no harness is available, return a loud-failure response
  // immediately rather than asking the router to pick from nothing.
  const codexSnap = snapshotById.get("codex_cli");
  const minimaxSnap = snapshotById.get("minimax_cli");
  const anyAvailable = codexSnap?.status === "available" || minimaxSnap?.status === "available";
  if (!anyAvailable) {
    const fallbackPick = pickDeterministicRecommendation(snapshots);
    const response: FallbackResponse = {
      taskType: "coding",
      executionTarget: "coding_harness",
      recommendedHarness: fallbackPick.harness,
      recommendedModelId: defaultModelIdFor(fallbackPick.harness),
      recommendedReasoningLevel: defaultReasoningLevelFor(fallbackPick.harness),
      reason: fallbackPick.reason,
      requiresProjectFolder: true,
      requiresUserApproval: true,
      alternatives: [],
      fallback: true,
      fallbackReason: "no_harness_available",
    };
    return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
  }

  // Resolve the OpenAI model id we want to call for the harness
  // recommender. We use the same OpenAI API recommender model the
  // existing `/api/harness/recommend` route uses; if it is missing
  // from the catalog we fall back to the deterministic preference
  // order rather than crashing.
  const openaiModels = modelsResp.models.filter((m) => m.providerId === "openai");
  const exact = openaiModels.find((m) => m.modelId === HARNESS_RECOMMENDER_MODEL_ID);
  const fallbackPick = pickDeterministicRecommendation(snapshots);
  const fallbackResponseShape = (reason: FallbackResponse["fallbackReason"]): FallbackResponse => ({
    taskType: "coding",
    executionTarget: "coding_harness",
    recommendedHarness: fallbackPick.harness,
    recommendedModelId: defaultModelIdFor(fallbackPick.harness),
    recommendedReasoningLevel: defaultReasoningLevelFor(fallbackPick.harness),
    reason: fallbackPick.reason,
    requiresProjectFolder: true,
    requiresUserApproval: true,
    alternatives: [],
    fallback: true,
    fallbackReason: reason,
  });
  if (!exact) {
    return NextResponse.json(fallbackResponseShape("model_not_listed"), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  // Build the catalog-shaped picker for the router prompt.
  const codexModels =
    registry
      .find((h) => h.id === "codex_cli")
      ?.allowedModelIds.map((id) => {
        const bare = id.startsWith("codex:") ? id.slice("codex:".length) : id;
        const meta = CODEX_CATALOG_MODELS.find((m) => m.id === bare);
        return {
          harness: "codex_cli",
          modelId: id,
          reasoningLevels: meta?.reasoningCapability
            ? // Best-effort: surface the documented effort levels per
              // Codex catalog row. The runtime validates against the
              // model's actual `reasoningCapability.options`.
              meta.reasoningCapability.kind === "effort_levels"
              ? meta.reasoningCapability.options.map((o) => o.value)
              : ["provider_default"]
            : ["provider_default"],
          status: codexSnap?.status ?? "unknown",
          unavailableReason: codexSnap?.unavailableReason ?? null,
        };
      }) ?? [];
  const minimaxModels =
    registry
      .find((h) => h.id === "minimax_cli")
      ?.allowedModelIds.map((id) => ({
        harness: "minimax_cli",
        modelId: id,
        reasoningLevels: ["provider_default"],
        status: minimaxSnap?.status ?? "unknown",
        unavailableReason: minimaxSnap?.unavailableReason ?? null,
      })) ?? [];

  try {
    const result = await generateText({
      model: openai(HARNESS_RECOMMENDER_MODEL_ID),
      output: Output.object({
        schema,
        name: "harness_recommendation",
        description:
          "Pick the best coding harness (Codex CLI vs MiniMax CLI), model, and reasoning level for a Control Room coding task.",
      }),
      providerOptions: { openai: { reasoningEffort: "low" } },
      system: `You recommend one coding harness for a Control Room coding task that the user already approved as a coding task. Return JSON only.

Available harnesses:
- Codex CLI (codex_cli): ChatGPT-subscription-backed. Best for coding tasks that benefit from Codex's coding-agent workflow. Reasoning levels are provider-native (low / medium / high / xhigh).
- MiniMax CLI (minimax_cli): MiniMax-token-plan-backed. The reasoning level is "provider_default" — do NOT invent another value. MiniMax CLI does not accept a reasoning-effort knob today; the harness passes "provider_default" verbatim.

Rules:
- Pick the harness the user is most likely to want. Prefer Codex CLI when it is available; switch to MiniMax CLI ONLY when Codex is unavailable, the user prefers MiniMax, or the task is simple enough that MiniMax is a good fit.
- Model must come from the listed catalog for the chosen harness. Never recommend a model id not in the catalog.
- For codex_cli, the reasoning level must be one of the documented effort levels for the chosen Codex model (low / medium / high / xhigh). For minimax_cli, the reasoning level must always be "provider_default".
- If a harness is unavailable, do NOT recommend it — fall back to the other harness.
- Keep reason short (<= 280 chars).
- "alternatives" may include at most one entry for each of the other harness if it is available.
- The "taskType" field is your classification of the user's instruction: coding (new feature / implementation), debugging (find/fix a bug), repo_edit (modify files), code_review (review existing code), or other.
- ALWAYS set executionTarget to "coding_harness".
- ALWAYS set requiresProjectFolder = true and requiresUserApproval = true.`,
      prompt: `Catalog:

Codex CLI models:
${JSON.stringify(codexModels, null, 2)}

MiniMax CLI models:
${JSON.stringify(minimaxModels, null, 2)}

User instruction:
${instruction}`,
    });
    const value = result.output;
    if (!isCodingHarness(value.recommendedHarness)) {
      throw new Error("invalid harness from router");
    }
    // Validate the recommended model against the harness catalog.
    const harnessEntry = registry.find((h) => h.id === value.recommendedHarness);
    if (!harnessEntry)
      throw new Error(`router picked an unknown harness: ${value.recommendedHarness}`);
    if (!harnessEntry.allowedModelIds.includes(value.recommendedModelId)) {
      throw new Error(
        `router picked an unsupported model ${value.recommendedModelId} for harness ${value.recommendedHarness}`,
      );
    }
    if (
      value.recommendedHarness === "minimax_cli" &&
      value.recommendedReasoningLevel !== "provider_default"
    ) {
      // Defensive: the system prompt explicitly tells the router
      // MiniMax must use provider_default. If the router drifts we
      // coerce it rather than passing a fake reasoning level.
      value.recommendedReasoningLevel = "provider_default";
    }
    const response: RecommendationResponse = {
      taskType: value.taskType,
      executionTarget: "coding_harness",
      recommendedHarness: value.recommendedHarness,
      recommendedModelId: value.recommendedModelId,
      recommendedReasoningLevel: value.recommendedReasoningLevel,
      reason: value.reason,
      requiresProjectFolder: true,
      requiresUserApproval: true,
      alternatives: value.alternatives.map((alt) => ({
        harness: alt.harness,
        modelId: alt.modelId,
        reasoningLevel: alt.reasoningLevel,
        reason: alt.reason,
      })),
    };
    return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const message = safeErrorMessage(err);
    // eslint-disable-next-line no-console
    console.error("[api/coding-harness/recommend] provider call failed", {
      provider: "openai",
      modelId: HARNESS_RECOMMENDER_MODEL_ID,
      error: message,
    });
    return NextResponse.json(fallbackResponseShape("provider_call_failed"), {
      headers: { "Cache-Control": "no-store" },
    });
  }
}

function defaultModelIdFor(harness: CodingHarness): string {
  return HARNESS_REGISTRY.find((h) => h.id === harness)?.defaultModelId ?? "codex:gpt-5.4-mini";
}

function defaultReasoningLevelFor(harness: CodingHarness): string {
  return HARNESS_REGISTRY.find((h) => h.id === harness)?.defaultReasoningLevel ?? "low";
}
