import { NextResponse } from "next/server";
import { openai } from "@ai-sdk/openai";
import { jsonSchema } from "@ai-sdk/provider-utils";
import { generateText, Output } from "ai";
import { getProject } from "@/lib/repo/projects";
import { getEffectiveModelsResponse } from "@/lib/providers/registry";
import { ensureDiscoveryFresh } from "@/lib/providers/openai-discovery";

export const dynamic = "force-dynamic";

type Harness = "pi" | "codex" | "opencode";

type Recommendation = {
  recommendedHarness: Harness;
  reasoning: string;
  alternatives?: Array<{ harness: Harness; reason: string }>;
};

type RecommendationResponse = Recommendation & {
  diagnostics: {
    recommenderProvider: "openai";
    recommenderModelId: string;
    fallback: false;
  };
};

// TODO(Stage 2): make the coding harness recommender model configurable separately.
const HARNESS_RECOMMENDER_MODEL_ID = "gpt-5.4-mini" as const;

type FallbackResponse = Recommendation & {
  diagnostics: {
    recommenderProvider: "openai";
    recommenderModelId: string;
    fallback: true;
  };
  fallback: true;
  fallbackReason: "model_not_listed" | "provider_call_failed";
  debug?: {
    provider: "openai";
    modelId: string;
    message: string;
  };
};

function fallbackResponse(
  reason: FallbackResponse["fallbackReason"],
  modelId: string,
  message: string,
): FallbackResponse {
  const response: FallbackResponse = {
    recommendedHarness: "pi",
    reasoning: "Fallback to Pi because harness recommendation failed.",
    diagnostics: {
      recommenderProvider: "openai",
      recommenderModelId: modelId,
      fallback: true,
    },
    fallback: true,
    fallbackReason: reason,
  };
  if (process.env.NODE_ENV !== "production") {
    response.debug = { provider: "openai", modelId, message };
  }
  return response;
}

const schema = jsonSchema<Recommendation>({
  type: "object",
  additionalProperties: false,
  required: ["recommendedHarness", "reasoning", "alternatives"],
  properties: {
    recommendedHarness: { type: "string", enum: ["pi", "codex", "opencode"] },
    reasoning: { type: "string", minLength: 1, maxLength: 280 },
    alternatives: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["harness", "reason"],
        properties: {
          harness: { type: "string", enum: ["pi", "codex", "opencode"] },
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

async function resolveHarnessRecommenderModelId(): Promise<{
  modelId: string;
  listed: boolean;
  availableIds: string[];
}> {
  await ensureDiscoveryFresh();
  const models = await getEffectiveModelsResponse();
  const openaiModels = models.models.filter((m) => m.providerId === "openai");
  const exact = openaiModels.find((m) => m.modelId === HARNESS_RECOMMENDER_MODEL_ID);
  return {
    modelId: HARNESS_RECOMMENDER_MODEL_ID,
    listed: Boolean(exact),
    availableIds: openaiModels.map((m) => m.modelId),
  };
}

function isHarness(value: unknown): value is Harness {
  return value === "pi" || value === "codex" || value === "opencode";
}

export async function POST(req: Request) {
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
  const projectId = typeof b.projectId === "string" ? b.projectId : "";
  const instruction = typeof b.instruction === "string" ? b.instruction.trim() : "";
  if (!projectId) return NextResponse.json({ error: "project_required" }, { status: 400 });
  if (!instruction) return NextResponse.json({ error: "instruction_required" }, { status: 400 });

  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });

  const resolved = await resolveHarnessRecommenderModelId();
  const modelId = resolved.modelId;
  if (!resolved.listed) {
    console.error("[api/harness/recommend] recommender model not listed", {
      provider: "openai",
      modelId,
      candidateModelIds: [HARNESS_RECOMMENDER_MODEL_ID],
      availableOpenAIModelIds: resolved.availableIds,
    });
    return NextResponse.json(
      fallbackResponse("model_not_listed", modelId, "gpt-5.4-mini is not listed in /api/models"),
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const result = await generateText({
      model: openai(modelId),
      output: Output.object({
        schema,
        name: "harness_recommendation",
        description: "Choose the best coding harness for a Control Room coding thread.",
      }),
      providerOptions: { openai: { reasoningEffort: "low" } },
      system: `You recommend one coding harness for a Control Room coding project chat. Return JSON only.

Available harnesses:
- Pi: default local implementation/debugging worker, good for normal repo changes, iterative practical work, running validation, and updating the deployed app from an external session.
- Codex: best when the user specifically wants Codex, OpenAI/Codex-related behavior, complex architectural coding, or tasks that benefit from Codex's coding-agent workflow.
- OpenCode: best for broad repo exploration, codebase navigation, multi-file inspection, and OpenCode-specific workflows.

Default: If unsure, recommend Pi.
Must choose exactly one of pi, codex, opencode. Keep reasoning short.`,
      prompt: `Project metadata:
Name: ${project.name}
Path: ${project.localPath}
Git remote: ${project.gitRemoteUrl ?? "none"}
Branch: ${project.gitBranch ?? "unknown"}

First coding task:
${instruction}`,
    });

    const value = result.output;
    if (!isHarness(value.recommendedHarness)) throw new Error("invalid harness");
    const response: RecommendationResponse = {
      ...value,
      diagnostics: {
        recommenderProvider: "openai",
        recommenderModelId: modelId,
        fallback: false,
      },
    };
    return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const message = safeErrorMessage(err);
    console.error("[api/harness/recommend] provider call failed", {
      provider: "openai",
      modelId,
      error: message,
    });
    return NextResponse.json(fallbackResponse("provider_call_failed", modelId, message), {
      headers: { "Cache-Control": "no-store" },
    });
  }
}
