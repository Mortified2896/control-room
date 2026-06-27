import "server-only";

import { generateText, Output, stepCountIs } from "ai";
import { z } from "zod/v4";
import { getEffectiveModelsResponse } from "@/lib/providers/registry";
import { resolveModel } from "@/lib/providers";
import { getRuntimeModel } from "@/lib/providers/runtime";
import { getEffectiveRouterSettings } from "@/lib/router/settings-store";
import type { ReasoningLevel } from "@/lib/providers/types";

export const dynamic = "force-dynamic";

type RecommendationResponse = {
  recommendedModelId: string;
  recommendedProvider: string;
  recommendedReasoningLevel: ReasoningLevel | null;
  reasoning: string;
  alternatives?: Array<{
    modelId: string;
    provider: string;
    reasoningLevel: ReasoningLevel | null;
    reason: string;
  }>;
  diagnostics: {
    recommenderProvider: string;
    recommenderModelId: string;
    fallback: boolean;
    fallbackReason: string | null;
    attemptedCandidateModel: string | null;
  };
};

const bodySchema = z.object({
  threadId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  message: z.string().min(1),
  currentModelId: z.string().nullable().optional(),
  currentProvider: z.string().nullable().optional(),
  currentReasoningLevel: z.enum(["low", "medium", "high"]).nullable().optional(),
  mode: z.literal("normal_chat"),
});

const outputSchema = z.object({
  recommendedModelId: z.string().min(1),
  recommendedProvider: z.string().min(1),
  recommendedReasoningLevel: z.enum(["low", "medium", "high"]).nullable(),
  reasoning: z.string().min(1).max(200),
  alternatives: z.array(
    z.object({
      modelId: z.string().min(1),
      provider: z.string().min(1),
      reasoningLevel: z.enum(["low", "medium", "high"]).nullable(),
      reason: z.string().min(1).max(160),
    }),
  ),
});

function fallbackResponse(
  input: z.infer<typeof bodySchema>,
  recommender: { provider: string; modelId: string },
  attemptedCandidateModel: string | null,
): RecommendationResponse {
  return {
    recommendedModelId: input.currentModelId ?? "gpt-5.4-mini",
    recommendedProvider: input.currentProvider ?? "openai",
    recommendedReasoningLevel: input.currentReasoningLevel ?? null,
    reasoning: "Keeping the current selection because recommendation failed.",
    diagnostics: {
      recommenderProvider: recommender.provider,
      recommenderModelId: recommender.modelId,
      fallback: true,
      fallbackReason: "model_recommendation_failed",
      attemptedCandidateModel,
    },
  };
}

export async function POST(request: Request) {
  let input: z.infer<typeof bodySchema>;
  try {
    input = bodySchema.parse(await request.json());
  } catch (err) {
    return Response.json({ error: "invalid_request", details: String(err) }, { status: 400 });
  }

  const settings = await getEffectiveRouterSettings();
  const recommender = { provider: "openai", modelId: settings.routerModelId || "gpt-5.4-mini" };
  let attemptedCandidateModel: string | null = null;

  try {
    const modelsPayload = await getEffectiveModelsResponse();
    const availableModels = modelsPayload.models
      .filter((m) => m.enabled && m.providerId !== "codex")
      .map((m) => ({
        provider: m.providerId,
        modelId: m.modelId,
        displayLabel: m.modelLabel,
        supportsReasoningControls: m.reasoningLevels.length > 0,
        allowedReasoningLevels: m.reasoningLevels,
        enabled: m.enabled,
        accessPath: m.accessPath ?? null,
        tier: m.tier,
      }));

    const recommenderResolved = resolveModel(recommender.modelId);
    if (!recommenderResolved.ok) {
      throw new Error(`recommender_model_unavailable:${JSON.stringify(recommenderResolved.error)}`);
    }

    const result = await generateText({
      model: getRuntimeModel(recommenderResolved.resolved),
      system:
        "You recommend the answer model and reasoning level for a normal chat message in Control Room. " +
        "Only choose enabled normal-chat models from the provided list. Do not choose Codex/coding harness models unless present as normal chat providers. " +
        "Prefer cheaper/faster models for simple prompts; stronger models or higher reasoning for complex planning, debugging, architecture, multi-step reasoning, or high-stakes decisions. " +
        "If the current model is appropriate, recommend keeping it. Reasoning must be null for models without reasoning controls. Keep reasons short and practical.",
      prompt: JSON.stringify({
        mode: input.mode,
        message: input.message,
        current: {
          modelId: input.currentModelId,
          provider: input.currentProvider,
          reasoningLevel: input.currentReasoningLevel ?? null,
        },
        availableModels,
        reasoningGuidance: {
          simple: ["low"],
          normalAnalysisOrPlanning: ["medium"],
          complexDebuggingArchitectureImportantDecisions: ["high"],
        },
      }),
      output: Output.object({ schema: outputSchema, name: "normal_chat_model_recommendation" }),
      stopWhen: stepCountIs(1),
    });

    const value = result.output;
    attemptedCandidateModel = value?.recommendedModelId ?? null;
    const picked = value
      ? availableModels.find(
          (m) => m.modelId === value.recommendedModelId && m.provider === value.recommendedProvider,
        )
      : null;
    if (!value || !picked) throw new Error("invalid_recommendation");
    const level = picked.supportsReasoningControls ? value.recommendedReasoningLevel : null;
    if (level && !picked.allowedReasoningLevels.includes(level)) throw new Error("invalid_reasoning_level");

    return Response.json({
      ...value,
      recommendedReasoningLevel: level,
      alternatives: value.alternatives?.filter((a) =>
        availableModels.some((m) => m.modelId === a.modelId && m.provider === a.provider),
      ),
      diagnostics: {
        recommenderProvider: recommender.provider,
        recommenderModelId: recommender.modelId,
        fallback: false,
        fallbackReason: null,
        attemptedCandidateModel,
      },
    } satisfies RecommendationResponse);
  } catch (err) {
    // Safe diagnostics only: never log secrets or request headers.
    console.error("[model/recommend] fallback", {
      recommenderProvider: recommender.provider,
      recommenderModelId: recommender.modelId,
      attemptedCandidateModel,
      reason: err instanceof Error ? err.message : String(err),
    });
    return Response.json(fallbackResponse(input, recommender, attemptedCandidateModel));
  }
}
