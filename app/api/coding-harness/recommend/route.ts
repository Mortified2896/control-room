import { NextResponse } from "next/server";
import { generateText, Output, stepCountIs } from "ai";
import { z } from "zod/v4";
import { getModelMeta, resolveModel } from "@/lib/providers";
import { getEffectiveModelsResponse } from "@/lib/providers/registry";
import { UNKNOWN_REASONING_CAPABILITY } from "@/lib/providers/capability";
import { getRuntimeModel, getRuntimeProviderOptions } from "@/lib/providers/runtime";
import { isCodexModelId, resolveCodexBinary, runCodexExec } from "@/lib/codex/runner";
import {
  probeHarnessStatuses,
  type HarnessStatusSnapshot,
} from "@/lib/harness/registry";
import {
  buildCodingHarnessCandidatesFromModels,
  buildRequestPayloadForTokenCount,
  getEffectiveCodingModelRoutingPolicy,
  runCodingHarnessRecommendation,
  type CodingHarnessCandidate,
  type CodingRecommenderLane,
  type TokenCountMetadata,
} from "@/lib/harness/model-routing";
import type { ConfiguredRecommenderRung } from "@/lib/router/recommender-config";
import { tryRecoverJsonObjectFromAiSdkError } from "@/lib/router/parse-json-fallback";

export const dynamic = "force-dynamic";

type CodingHarness = "codex_cli" | "minimax_cli";
type RecommendationTaskType = "coding" | "debugging" | "repo_edit" | "code_review" | "other";

const outputSchema = z.object({
  selectedHarness: z.enum(["codex_cli", "minimax_cli"]),
  selectedModelId: z.string().min(1),
  selectedReasoningLevel: z.string().min(1),
  harnessExplanation: z.string().min(1).max(500),
  modelExplanation: z.string().min(1).max(500),
  alternatives: z.array(z.object({
    harness: z.enum(["codex_cli", "minimax_cli"]),
    modelId: z.string().min(1),
    reasoningLevel: z.string().min(1),
    reason: z.string().min(1).max(240),
  })).default([]),
});

type RecommendationResponse = {
  taskType: RecommendationTaskType;
  executionTarget: "coding_harness";
  recommendedHarness: CodingHarness | null;
  recommendedModelId: string | null;
  recommendedReasoningLevel: string | null;
  reason: string;
  recommenderLane: CodingRecommenderLane;
  recommenderEngine: {
    type: "model_recommender";
    label: "Router/recommender engine";
    providerId: "openai" | "codex" | "minimax";
    modelId: string;
    reasoningLevel?: string;
  };
  fallbackRecommender: {
    configured: boolean;
    attempted: boolean;
    used: boolean;
    providerId: "openai" | "codex" | "minimax" | null;
    modelId: string | null;
    reasoningLevel?: string;
    failureReason?: string;
  };
  executionModel: null | {
    modelId: string;
    reasoningLevel: string;
    selectionSource: "recommender_output";
    reason: string;
  };
  requiresProjectFolder: true;
  requiresUserApproval: true;
  executionMode?: "read_only" | "workspace_write";
  alternatives: Array<{
    harness: CodingHarness;
    modelId: string;
    reasoningLevel: string;
    reason: string;
  }>;
  usageSummary?: Record<string, string>;
  blocked?: boolean;
  diagnostics: {
    recommenderLane: CodingRecommenderLane;
    primaryRecommender: { providerId: string; modelId: string; reasoningLevel?: string };
    fallbackRecommender: { configured: boolean; providerId: string | null; modelId: string | null; reasoningLevel?: string };
    callAttempts: Array<{
      source: "configured" | "configured_fallback";
      providerId: "openai" | "codex" | "minimax";
      modelId: string;
      reasoning: string;
      status: "success" | "failed";
      reason: string;
    }>;
  };
  routingMetadata?: {
    recommenderLane: CodingRecommenderLane;
    selectionReason: "default_lane" | "long_prompt_lane";
    selectionSource: "recommender_output" | "blocked_no_recommendation";
    tokenCount: TokenCountMetadata;
  };
};

function buildCodingRecommenderPrompt(args: {
  instruction: string;
  lane: CodingRecommenderLane;
  tokenCount: TokenCountMetadata;
  candidates: ReadonlyArray<CodingHarnessCandidate>;
  snapshots: ReadonlyArray<HarnessStatusSnapshot>;
}) {
  const system = `You are Control Room's coding harness recommender. You are a decision engine only; you do not execute the user's task.

Hard rules:
- Select exactly one authorized coding harness/path and execution model from candidates.
- Router/recommender engine ids and fallback recommender ids are never execution defaults.
- The deterministic lane (${args.lane}) was chosen from token/context metadata only; it must not determine the execution model.
- Return JSON only with selectedHarness, selectedModelId, selectedReasoningLevel, harnessExplanation, modelExplanation, alternatives.
- harnessExplanation and modelExplanation are required and must be distinct, user-facing explanations.
- Do not invent models or harnesses.`;
  const user = JSON.stringify({
    instruction: args.instruction,
    recommenderLane: args.lane,
    tokenCount: args.tokenCount,
    authorizedCandidates: args.candidates,
    harnessStatus: args.snapshots,
  });
  return { system, user };
}

function parseJsonObjectFromText(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (fenced) return JSON.parse(fenced);
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("coding_recommender_returned_non_json");
  }
}

async function runCodexRecommender(args: { modelId: string; system: string; user: string }) {
  const binary = resolveCodexBinary();
  if (!binary) throw new Error("codex_cli_not_installed");
  const codexModelId = args.modelId.startsWith("codex:") ? args.modelId.slice("codex:".length) : args.modelId;
  if (!isCodexModelId(codexModelId)) throw new Error("invalid_codex_recommender_model");
  const schemaHint = `Return ONLY minified JSON with this shape: {"selectedHarness":"codex_cli|minimax_cli","selectedModelId":"string","selectedReasoningLevel":"string","harnessExplanation":"why this harness","modelExplanation":"why this execution model","alternatives":[{"harness":"codex_cli|minimax_cli","modelId":"string","reasoningLevel":"string","reason":"short"}]}. No markdown.`;
  const result = await runCodexExec(binary, `${args.system}\n\n${schemaHint}\n\nInput JSON:\n${args.user}`, {
    model: codexModelId,
    maxPromptLength: 24_000,
  });
  if (!result.ok) throw new Error(result.error);
  return outputSchema.parse(parseJsonObjectFromText(result.responseText));
}

async function runConfiguredCodingRecommender(args: {
  rung: ConfiguredRecommenderRung;
  lane: CodingRecommenderLane;
  payload: ReturnType<typeof buildRequestPayloadForTokenCount>;
  candidates: ReadonlyArray<CodingHarnessCandidate>;
  tokenCount: TokenCountMetadata;
  instruction: string;
  snapshots: ReadonlyArray<HarnessStatusSnapshot>;
}) {
  if (process.env.CONTROL_ROOM_FAKE_LLM === "1") {
    const preferred = args.candidates.find((c) => c.harnessId === "codex_cli") ?? args.candidates[0];
    if (!preferred) throw new Error("no_authorized_candidates");
    return {
      selectedHarness: preferred.harnessId,
      selectedModelId: preferred.modelId,
      selectedReasoningLevel: preferred.reasoningLevel,
      harnessExplanation: `${preferred.harnessLabel} is available and authorized for this coding task.`,
      modelExplanation: `${preferred.modelId} is an authorized execution model returned by the mocked recommender, not by lane policy.`,
      alternatives: args.candidates
        .filter((c) => c.harnessId !== preferred.harnessId)
        .slice(0, 1)
        .map((c) => ({ harness: c.harnessId, modelId: c.modelId, reasoningLevel: c.reasoningLevel, reason: `${c.harnessLabel} is also authorized.` })),
    };
  }

  const resolved = resolveModel(args.rung.modelId);
  if (!resolved.ok) throw new Error(`resolve_failed:${resolved.error.kind}`);
  const prompt = buildCodingRecommenderPrompt({
    instruction: args.instruction,
    lane: args.lane,
    tokenCount: args.tokenCount,
    candidates: args.candidates,
    snapshots: args.snapshots,
  });
  if (resolved.resolved.providerId === "codex") {
    return runCodexRecommender({ modelId: resolved.resolved.modelId, system: prompt.system, user: prompt.user });
  }
  const meta = getModelMeta(resolved.resolved.modelId);
  const capability = meta?.reasoningCapability ?? UNKNOWN_REASONING_CAPABILITY;
  const providerOptions = args.rung.reasoningLevel
    ? getRuntimeProviderOptions({ resolved: resolved.resolved, capability, reasoningOption: args.rung.reasoningLevel })
    : undefined;
  const result = await generateText({
    model: getRuntimeModel(resolved.resolved),
    system: prompt.system,
    prompt: prompt.user,
    output: Output.object({ schema: outputSchema, name: "coding_harness_recommendation" }),
    stopWhen: stepCountIs(1),
    ...(providerOptions ? { providerOptions } : {}),
  }).catch(async (err: unknown) => {
    // Some providers (notably MiniMax-M3) wrap their JSON output in a
    // `<think>` reasoning block followed by a ```json ... ``` fenced
    // block, even when the request asked for strict JSON via
    // `response_format: { type: "json_schema" }`. AI SDK 6's
    // `safeParseJSON` rejects the leading `<think>` prologue and throws
    // `NoObjectGeneratedError` ("No object generated: could not parse
    // the response."). The AI SDK error carries the raw response text
    // on `.text` — try a safe JSON-object extraction on it before
    // re-throwing. Any other error (network, auth, schema mismatch on
    // the extracted payload) re-throws verbatim. We do NOT guess
    // missing fields and do NOT accept non-conformant payloads.
    const recovered = tryRecoverJsonObjectFromAiSdkError(err);
    if (recovered === null) throw err;
    if (!recovered.ok) throw err;
    const validated = outputSchema.safeParse(recovered.value);
    if (!validated.success) throw err;
    return { output: validated.data };
  });
  return result.output;
}

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

  const [snapshots, modelsPayload] = await Promise.all([
    probeHarnessStatuses().catch(() => [] as HarnessStatusSnapshot[]),
    getEffectiveModelsResponse(),
  ]);
  const candidates = buildCodingHarnessCandidatesFromModels(modelsPayload.models, snapshots);
  const policy = await getEffectiveCodingModelRoutingPolicy();
  const payload = buildRequestPayloadForTokenCount({
    instruction,
    harnessMetadata: snapshots,
    threadHistory: b.threadHistory,
    projectContext: b.projectContext,
    retrievedSnippets: b.retrievedSnippets,
  });

  const result = await runCodingHarnessRecommendation({
    payload,
    snapshots,
    candidates,
    policy,
    runRung: (args) => runConfiguredCodingRecommender({ ...args, instruction, snapshots }),
  });

  if (!result.ok) {
    const response: RecommendationResponse = {
      taskType: "coding",
      executionTarget: "coding_harness",
      recommendedHarness: null,
      recommendedModelId: null,
      recommendedReasoningLevel: null,
      reason: result.reason,
      recommenderLane: result.lane,
      recommenderEngine: {
        type: "model_recommender",
        label: "Router/recommender engine",
        providerId: result.primary.providerId,
        modelId: result.primary.modelId,
        reasoningLevel: result.primary.reasoningLevel,
      },
      fallbackRecommender: {
        configured: Boolean(result.fallbackConfigured),
        attempted: result.callAttempts.some((a) => a.source === "configured_fallback"),
        used: false,
        providerId: result.fallbackConfigured?.providerId ?? null,
        modelId: result.fallbackConfigured?.modelId ?? null,
        reasoningLevel: result.fallbackConfigured?.reasoningLevel,
        failureReason: result.callAttempts.find((a) => a.source === "configured_fallback")?.reason,
      },
      executionModel: null,
      requiresProjectFolder: true,
      requiresUserApproval: true,
      executionMode: inferExecutionMode(instruction),
      alternatives: [],
      usageSummary: Object.fromEntries(snapshots.map((s) => [s.id, summarizeUsage(s.usage)])),
      blocked: true,
      diagnostics: {
        recommenderLane: result.lane,
        primaryRecommender: { providerId: result.primary.providerId, modelId: result.primary.modelId, reasoningLevel: result.primary.reasoningLevel },
        fallbackRecommender: { configured: Boolean(result.fallbackConfigured), providerId: result.fallbackConfigured?.providerId ?? null, modelId: result.fallbackConfigured?.modelId ?? null, reasoningLevel: result.fallbackConfigured?.reasoningLevel },
        callAttempts: [...result.callAttempts],
      },
      routingMetadata: {
        recommenderLane: result.lane,
        selectionReason: result.lane === "long-prompt" ? "long_prompt_lane" : "default_lane",
        selectionSource: "blocked_no_recommendation",
        tokenCount: result.tokenCount,
      },
    };
    return NextResponse.json(response, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  const fallbackAttempt = result.callAttempts.find((a) => a.source === "configured_fallback");
  const response: RecommendationResponse = {
    taskType: "coding",
    executionTarget: "coding_harness",
    recommendedHarness: result.recommendation.selectedHarness,
    recommendedModelId: result.recommendation.selectedModelId,
    recommendedReasoningLevel: result.recommendation.selectedReasoningLevel,
    reason: result.recommendation.harnessExplanation,
    recommenderLane: result.lane,
    recommenderEngine: {
      type: "model_recommender",
      label: "Router/recommender engine",
      providerId: result.recommender.providerId,
      modelId: result.recommender.modelId,
      reasoningLevel: result.recommender.reasoningLevel,
    },
    fallbackRecommender: {
      configured: Boolean(result.fallbackConfigured),
      attempted: Boolean(fallbackAttempt),
      used: result.fallbackUsed,
      providerId: result.fallbackConfigured?.providerId ?? null,
      modelId: result.fallbackConfigured?.modelId ?? null,
      reasoningLevel: result.fallbackConfigured?.reasoningLevel,
      failureReason: fallbackAttempt?.status === "failed" ? fallbackAttempt.reason : undefined,
    },
    executionModel: {
      modelId: result.recommendation.selectedModelId,
      reasoningLevel: result.recommendation.selectedReasoningLevel,
      selectionSource: "recommender_output",
      reason: result.recommendation.modelExplanation,
    },
    requiresProjectFolder: true,
    requiresUserApproval: true,
    executionMode: inferExecutionMode(instruction),
    alternatives: result.recommendation.alternatives ?? [],
    usageSummary: Object.fromEntries(snapshots.map((s) => [s.id, summarizeUsage(s.usage)])),
    diagnostics: {
      recommenderLane: result.lane,
      primaryRecommender: { providerId: result.callAttempts[0]?.providerId ?? result.recommender.providerId, modelId: result.callAttempts[0]?.modelId ?? result.recommender.modelId, reasoningLevel: result.callAttempts[0]?.reasoning || undefined },
      fallbackRecommender: { configured: Boolean(result.fallbackConfigured), providerId: result.fallbackConfigured?.providerId ?? null, modelId: result.fallbackConfigured?.modelId ?? null, reasoningLevel: result.fallbackConfigured?.reasoningLevel },
      callAttempts: [...result.callAttempts],
    },
    routingMetadata: {
      recommenderLane: result.lane,
      selectionReason: result.lane === "long-prompt" ? "long_prompt_lane" : "default_lane",
      selectionSource: "recommender_output",
      tokenCount: result.tokenCount,
    },
  };
  return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
}

export function inferExecutionMode(instruction: string): "read_only" | "workspace_write" {
  const text = instruction.toLowerCase();
  const explicitlyReadOnly =
    /\bdo not\s+(?:modify|change|edit)\s+files?\b/.test(text) ||
    /\bdo not\s+write\s+to\s+the\s+repo\b/.test(text) ||
    /\bdon['’]?t\s+(?:modify|change|edit)\s+files?\b/.test(text) ||
    /\bread[- ]only\b/.test(text) ||
    /\binspect only\b/.test(text) ||
    /\bno edits\b/.test(text);
  const implementationIntent =
    /\b(apply (?:this )?patch|change|update|fix|implement)\b/.test(text) ||
    /\b(add|update|add\/update)\s+tests?\b/.test(text) ||
    /\badjust\s+settings?\b/.test(text);
  if (implementationIntent) return "workspace_write";
  return explicitlyReadOnly ? "read_only" : "workspace_write";
}

function summarizeUsage(usage: unknown): string {
  if (!usage || typeof usage !== "object") return "usage unknown";
  const u = usage as { provider?: string; status?: string; rawSummary?: string | null; modelRemains?: Array<{ modelName?: string; currentIntervalRemainingPercent?: number | null; currentWeeklyRemainingPercent?: number | null }> };
  if (u.provider === "codex_cli") return u.status === "unknown" ? "Codex usage unknown" : `Codex usage ${u.status ?? "unknown"}`;
  if (u.provider === "minimax_cli") {
    const first = u.modelRemains?.[0];
    const pct = first ? [first.currentIntervalRemainingPercent, first.currentWeeklyRemainingPercent].filter((v) => typeof v === "number").join("% / ") : "";
    return `MiniMax quota ${u.status ?? "unknown"}${pct ? ` (${pct}%)` : ""}`;
  }
  return "usage unknown";
}
