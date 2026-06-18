import { openai } from "@ai-sdk/openai";
import { frontendTools } from "@assistant-ui/react-ai-sdk";
import { type JSONSchema7, streamText, convertToModelMessages, type UIMessage } from "ai";
import { isDbConfigured } from "@/lib/db";
import { extractLatestUserMessage, uiMessageText } from "@/lib/assistant-ui/thread-messages";
import { createMessage } from "@/lib/repo/threads";
import { resolveModel } from "@/lib/providers";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validThreadId(threadId: unknown): string | null {
  return typeof threadId === "string" && UUID_RE.test(threadId) ? threadId : null;
}

async function persistUserMessage(threadId: string, messages: UIMessage[], modelId: string | null) {
  const message = extractLatestUserMessage(messages);
  if (!message) return;
  await createMessage({
    threadId,
    role: "user",
    content: uiMessageText(message),
    parts: message.parts,
    modelId,
  });
}

async function persistAssistantMessage(threadId: string, message: UIMessage, modelId: string) {
  await createMessage({
    threadId,
    role: "assistant",
    content: uiMessageText(message),
    parts: message.parts,
    modelId,
  });
}

export async function POST(req: Request) {
  const {
    messages,
    system,
    tools,
    modelId,
    threadId: rawThreadId,
  }: {
    messages: UIMessage[];
    system?: string;
    tools?: Record<string, { description?: string; parameters: JSONSchema7 }>;
    modelId?: string;
    threadId?: string;
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

  // Only real chat messages go into model context. Ratings, notes, feedback,
  // traces, debug metadata, and routing metadata are not loaded here.
  const modelMessages = await convertToModelMessages(messages);
  const threadId = validThreadId(rawThreadId);

  if (threadId && isDbConfigured()) {
    void persistUserMessage(threadId, messages, result.resolved.modelId).catch((err) => {
      console.error(
        "[api/chat] failed to persist user message:",
        err instanceof Error ? err.message : err,
      );
    });
  }

  const streamResult = streamText({
    model: openai(result.resolved.modelId),
    messages: modelMessages,
    system,
    tools: {
      ...frontendTools(tools ?? {}),
    },
  });

  return streamResult.toUIMessageStreamResponse({
    originalMessages: messages,
    async onFinish({ responseMessage }) {
      if (!threadId || !isDbConfigured()) return;
      try {
        await persistAssistantMessage(threadId, responseMessage, result.resolved.modelId);
      } catch (err) {
        console.error(
          "[api/chat] failed to persist assistant message:",
          err instanceof Error ? err.message : err,
        );
      }
    },
  });
}
