/**
 * Zod schemas for the Router A/B data parts emitted by `/api/chat`.
 *
 * The `useChatRuntime({ dataPartSchemas })` option type-validates the data
 * parts the chat transport parses out of the SSE stream, and it also keeps
 * the data parts attached to the assistant message state (otherwise the
 * unknown data parts would be discarded). Both schemas must be present.
 */
import { z } from "zod/v4";
import type { RouterAbDataParts } from "@/app/api/chat/route";

const routerAbSchema = z.object({
  sessionId: z.string(),
  sideA: z.object({
    modelId: z.string(),
    reasoningLevel: z.enum(["low", "medium", "high"]),
  }),
  sideB: z
    .object({
      modelId: z.string(),
      reasoningLevel: z.enum(["low", "medium", "high"]),
    })
    .nullable(),
  recommendation: z
    .object({
      recommendedModel: z.string(),
      recommendedReasoningLevel: z.enum(["low", "medium", "high"]),
      confidence: z.number().min(0).max(1),
      taskType: z.string(),
      shortReason: z.string(),
    })
    .nullable(),
  usedFallback: z.boolean(),
  fallbackReason: z.string().nullable(),
  skipReason: z.string().nullable(),
  shortReason: z.string().nullable(),
  taskType: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
});

const routerAbSideBSchema = z.object({
  sessionId: z.string(),
  sideBText: z.string(),
  sideBLatencyMs: z.number().int().nonnegative(),
});

export const routerAbDataSchemas: {
  "router-ab": typeof routerAbSchema;
  "router-ab-side-b": typeof routerAbSideBSchema;
} = {
  "router-ab": routerAbSchema,
  "router-ab-side-b": routerAbSideBSchema,
};

// Re-export so consumers don't need to import from `@/app/api/chat/route`.
export type { RouterAbDataParts };
