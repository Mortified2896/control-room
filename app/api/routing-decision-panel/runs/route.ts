import "server-only";

import { z } from "zod/v4";
import {
  createFullRoutingDecisionRun,
  updateFullRoutingDecisionRun,
} from "@/lib/repo/router-telemetry";
import type {
  ChangedFieldKey,
  PanelHarness,
  RoutingDecisionPanel,
  RoutingDecisionPanelSelection,
} from "@/lib/router/routing-decision-panel-types";

export const dynamic = "force-dynamic";

const selectionSchema = z.object({
  contextDecision: z.enum(["chat_only", "harness_needed"]),
  modelId: z.string(),
  reasoningLevel: z.string(),
  harness: z.enum(["normal_chat", "repo_file_harness"]) satisfies z.ZodType<PanelHarness>,
  changedFields: z.array(
    z.enum(["context", "model", "reasoning", "harness"]) satisfies z.ZodType<ChangedFieldKey>,
  ),
  comment: z.string().max(1000),
}) satisfies z.ZodType<RoutingDecisionPanelSelection>;

const panelSchema = z.object({
  contextDecision: z.object({
    recommended: z.enum(["chat_only", "harness_needed"]),
    explanation: z.string().min(1).max(2000),
  }),
  executionPackage: z.object({
    model: z.object({
      recommended: z.string(),
      alternatives: z.array(z.string()),
    }),
    reasoningLevel: z.object({
      recommended: z.string(),
      supportedValues: z.array(z.string()),
    }),
    harness: z.object({
      recommended: z.enum(["normal_chat", "repo_file_harness"]),
      alternatives: z.array(z.enum(["normal_chat", "repo_file_harness"])),
    }),
    explanation: z.string().min(1).max(2000),
  }),
  confidence: z.number().min(0).max(1),
  costTier: z.enum(["standard", "expensive", "cheap"]),
  latencyMs: z.number().min(0),
}) satisfies z.ZodType<RoutingDecisionPanel>;

const createSchema = z.object({
  threadId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  promptHash: z.string().min(1).max(128),
  promptText: z.string().nullable().optional(),
  panel: panelSchema,
  selection: selectionSchema,
  changedFields: z.array(
    z.enum(["context", "model", "reasoning", "harness"]) satisfies z.ZodType<ChangedFieldKey>,
  ),
  comment: z.string().max(1000).nullable().optional(),
  recommendationRunId: z.string().nullable().optional(),
});

const updateSchema = z.object({
  runId: z.string().uuid(),
  selection: selectionSchema.optional(),
  changedFields: z
    .array(
      z.enum(["context", "model", "reasoning", "harness"]) satisfies z.ZodType<ChangedFieldKey>,
    )
    .optional(),
  comment: z.string().max(1000).nullable().optional(),
});

/**
 * POST — persist the original recommendation + the user's final
 * selection + the diff + the optional comment.
 *
 * Idempotency: the chat composer fires this exactly once per
 * panel render. The DB row is the audit-of-record for the
 * "what did the recommender suggest, and what did the user
 * actually send?" question — future dashboards consume this
 * table to compute correction rates per field and surface
 * common correction comments.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const data = parsed.data;
  const runId = await createFullRoutingDecisionRun({
    threadId: data.threadId ?? null,
    projectId: data.projectId ?? null,
    promptHash: data.promptHash,
    promptText: data.promptText ?? null,
    panel: data.panel,
    selection: data.selection,
    changedFields: data.changedFields,
    comment: data.comment ?? null,
    recommendationRunId: data.recommendationRunId ?? null,
    confidence: data.panel.confidence,
    costTier: data.panel.costTier,
    latencyMs: data.panel.latencyMs,
  });
  return Response.json({ runId });
}

/**
 * PATCH — update the selection / changedFields / comment on an
 * existing row. The `panel` field is immutable post-persist;
 * the original recommendation is the audit-of-record and the
 * user can only edit what they actually sent.
 */
export async function PATCH(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const data = parsed.data;
  await updateFullRoutingDecisionRun(data.runId, {
    selection: data.selection,
    changedFields: data.changedFields,
    comment: data.comment ?? null,
  });
  return Response.json({ ok: true });
}