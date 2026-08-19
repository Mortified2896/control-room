import { NextResponse } from "next/server";
import { openai } from "@ai-sdk/openai";
import { jsonSchema } from "@ai-sdk/provider-utils";
import { generateText, Output } from "ai";
import { isDbConfigured } from "@/lib/db";
import { getEpisode, saveTitleCandidates, type TitleCandidateInput } from "@/lib/repo/create-room";
import { listMessages } from "@/lib/repo/threads";
import { resolveModel } from "@/lib/providers";

const titleOutputSchema = jsonSchema<{ candidates: TitleCandidateInput[] }>({
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      minItems: 5,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "rationale", "style"],
        properties: {
          title: { type: "string", minLength: 3, maxLength: 100 },
          rationale: { type: "string", minLength: 8, maxLength: 240 },
          style: { type: "string", minLength: 2, maxLength: 60 },
        },
      },
    },
  },
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isDbConfigured()) return NextResponse.json({ error: "db_not_configured" }, { status: 503 });
  try {
    const episode = await getEpisode(id);
    if (!episode) return NextResponse.json({ error: "episode_not_found" }, { status: 404 });
    let modelId: string | undefined;
    try {
      const body = (await req.json()) as { modelId?: unknown };
      if (typeof body.modelId === "string") modelId = body.modelId;
    } catch {
      // The selected/default configured model will be used.
    }
    const resolved = resolveModel(modelId);
    if (!resolved.ok) {
      const message =
        resolved.error.kind === "provider_disabled" || resolved.error.kind === "no_models_available"
          ? "Provider API key is not configured for local development."
          : "The selected model is not available.";
      return NextResponse.json({ error: "provider_unavailable", message }, { status: 503 });
    }
    if (resolved.resolved.providerId !== "openai") {
      return NextResponse.json(
        { error: "provider_not_implemented", message: "The selected provider is not implemented." },
        { status: 501 },
      );
    }
    const messages = await listMessages(episode.threadId);
    const recentFeedback = messages
      .filter((message) => message.role === "user" && message.content?.trim())
      .slice(-4)
      .map((message) => message.content)
      .join("\n");
    const result = await generateText({
      model: openai(resolved.resolved.modelId),
      output: Output.object({
        schema: titleOutputSchema,
        name: "episode_title_candidates",
        description: "Exactly five distinct title candidates for a Learn Like A Baby episode.",
      }),
      system:
        "You are the title editor for Learn Like A Baby, a beginner language-learning video series. Return exactly five distinct, polished titles. Titles should be emotionally engaging and YouTube-native without clickbait. Keep rationales concise and describe each style clearly.",
      prompt: `Episode code: ${episode.episodeCode}
Working title: ${episode.workingTitle ?? "Untitled episode"}
Selected idea/foundation: ${episode.selectedIdea ?? "Not selected yet"}
Target learner level: ${episode.targetLearnerLevel ?? "Beginner"}
Current workflow step: ${episode.workflowStep}
Recent user feedback:
${recentFeedback || "No additional feedback yet."}`,
    });
    const candidates = result.output.candidates;
    if (candidates.length !== 5) throw new Error("model_returned_invalid_candidate_count");
    return NextResponse.json(
      {
        candidates: await saveTitleCandidates(id, candidates),
        generatedBy: resolved.resolved.modelId,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "episode_not_found")
      return NextResponse.json({ error: "episode_not_found" }, { status: 404 });
    console.error(
      "[create-room title-candidates POST]",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json(
      { error: "generation_failed", message: "The model could not generate title candidates." },
      { status: 500 },
    );
  }
}
