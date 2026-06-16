import { openai } from "@ai-sdk/openai";
import { frontendTools } from "@assistant-ui/react-ai-sdk";
import { type JSONSchema7, streamText, convertToModelMessages, type UIMessage } from "ai";
import { resolveModel } from "@/lib/providers";

export async function POST(req: Request) {
  const {
    messages,
    system,
    tools,
    modelId,
  }: {
    messages: UIMessage[];
    system?: string;
    tools?: Record<string, { description?: string; parameters: JSONSchema7 }>;
    modelId?: string;
  } = await req.json();

  const result = resolveModel(modelId);

  if (!result.ok) {
    const err = result.error;
    if (err.kind === "no_models_available") {
      return Response.json(
        {
          error: "no_models_available",
          message: "No models are available. Configure a provider API key in .env.local.",
        },
        { status: 503 },
      );
    }
    if (err.kind === "provider_disabled") {
      return Response.json(
        {
          error: "provider_disabled",
          providerId: err.providerId,
          reason: err.reason,
        },
        { status: 503 },
      );
    }
    return Response.json(
      {
        error: "unknown_model",
        modelId: err.modelId,
        allowedIds: err.allowedIds,
      },
      { status: 400 },
    );
  }

  if (result.resolved.providerId !== "openai") {
    return Response.json(
      {
        error: "provider_not_implemented",
        providerId: result.resolved.providerId,
        message: "Provider is not implemented yet",
      },
      { status: 501 },
    );
  }

  const streamResult = streamText({
    model: openai(result.resolved.modelId),
    messages: await convertToModelMessages(messages),
    system,
    tools: {
      ...frontendTools(tools ?? {}),
    },
  });

  return streamResult.toUIMessageStreamResponse();
}
