import "server-only";

import { generateText, stepCountIs } from "ai";
import { z } from "zod/v4";
import { getModelMeta, resolveModel } from "@/lib/providers";
import type { ResolvedModel } from "@/lib/providers/types";
import { getRuntimeModel, getRuntimeProviderOptions } from "@/lib/providers/runtime";
import { UNKNOWN_REASONING_CAPABILITY } from "@/lib/providers/capability";
import { isCodexModelId, resolveCodexBinary, runCodexExec } from "@/lib/codex/runner";
import {
  buildConfiguredRecommenderChain,
  type ConfiguredRecommenderRung,
} from "@/lib/router/recommender-config";
import { getEffectiveRouterSettings } from "@/lib/router/settings-store";
import { createDecisionRun, updateDecisionRun } from "@/lib/repo/router-telemetry";
import { estimateRecommendation, latencyOutcome, promptHash } from "@/lib/router/telemetry";

export const dynamic = "force-dynamic";

type Decision = "normal_chat" | "coding_task";
type DecisionSource = "model" | "manual_after_model_error";

/**
 * Stable discriminator for the per-rung failure surfaced in the
 * `error_details` block. The UI uses these strings verbatim to
 * render the failure card, and the DB error_json column accepts
 * any string. Keep the set closed so the UI can list every
 * possible value without falling back to a generic "error".
 */
export type DecisionErrorType =
  | "usage_limit"
  | "auth"
  | "provider_disabled"
  | "network"
  | "schema_parse"
  | "schema_validation"
  | "empty_output"
  | "provider_configuration_error"
  | "not_attempted"
  | "unknown";

/**
 * A single rung's outcome. `attempted: false` means the chain
 * didn't get to this rung (either because no fallback is
 * configured or because the primary didn't fail). `succeeded`
 * is true only for the rung that produced a valid decision;
 * `errorType` + `errorMessageSafe` describe a real failure. The
 * UI uses these together so it can distinguish "Primary failed
 * and Fallback succeeded" from "Primary failed and Fallback
 * failed" from "Primary succeeded".
 */
export type RungAttempt = {
  source: "configured" | "configured_fallback";
  modelId: string;
  providerId: "openai" | "codex" | "minimax" | "unknown";
  attempted: boolean;
  succeeded: boolean;
  errorType: DecisionErrorType;
  errorMessageSafe: string | null;
};

/**
 * The structured `error_details` block the UI renders when the
 * decision call fails. Always present (even on success) so the
 * client can show what model actually decided. We never include
 * API keys, bearer tokens, or raw stderr — only the model id,
 * provider id, error type, and sanitized error message.
 */
export type DecisionErrorDetails = {
  primary_recommender_model_id: string | null;
  primary_provider_path: "openai" | "codex" | "minimax" | "unknown";
  primary_error_type: DecisionErrorType | null;
  primary_error_message_safe: string | null;
  fallback_recommender_model_id: string | null;
  fallback_provider_path: "openai" | "codex" | "minimax" | "unknown" | null;
  fallback_attempted: boolean;
  fallback_error_type: DecisionErrorType | null;
  fallback_error_message_safe: string | null;
  final_decision_source: DecisionSource;
};

const decideSchema = z.object({
  threadId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  message: z.string().min(1),
});

const actionSchema = z.object({
  runId: z.string().min(1),
  userAction: z.enum([
    "approved",
    "corrected_to_coding_task",
    "corrected_to_normal_chat",
    "canceled",
  ]),
  userComment: z.string().max(1000).nullable().optional(),
  finalDecision: z.enum(["normal_chat", "coding_task"]).nullable().optional(),
});

const outputSchema = z.object({
  decision: z.enum(["normal_chat", "coding_task"]),
  reason: z.string().min(1).max(220),
  ambiguity: z.enum(["low", "medium", "high"]),
  signals: z.array(z.string().min(1).max(80)).max(8),
});

type DecisionOutput = z.infer<typeof outputSchema>;

/**
 * System prompt body. Shared between the Codex CLI prompt and
 * the OpenAI / MiniMax prompt. The non-Codex path appends an
 * extra JSON-only instruction (see `nonCodexJsonOnlySuffix`)
 * because MiniMax in particular does not honor the AI SDK's
 * `Output.object({ schema })` helper reliably.
 */
const DECISION_SYSTEM_PROMPT = `Classify the user prompt as either normal_chat or coding_task.

Use coding_task if the user is asking to inspect a repo/codebase, change code, implement a feature, fix a bug, debug build/typecheck/test failures, run tests, modify app behavior, create/apply migrations, edit components/API routes, investigate logs/source files, or produce a patch.

Use normal_chat if the user is asking for explanation, brainstorming, translation, simple factual answer, writing a prompt, summarizing a screenshot, product/design discussion without explicit code execution/change, or model routing discussion only.

Ambiguous cases: prefer normal_chat unless the prompt clearly needs codebase inspection/change/execution. Set ambiguity accordingly. The user can correct the decision.`;

const NON_CODEX_JSON_ONLY_SUFFIX = `
Respond with a single JSON object matching this exact shape:
{"decision":"normal_chat|coding_task","reason":"<=220 chars, user-visible","ambiguity":"low|medium|high","signals":["<=8 strings, each <=80 chars"]}.

Rules:
- No markdown, no code fences, no commentary, no trailing text.
- The first character of your response MUST be "{".
- The last character of your response MUST be "}".
- Use only the enum values shown above for "decision" and "ambiguity".
- If you cannot decide, return {"decision":"normal_chat","reason":"<short>","ambiguity":"high","signals":["<short>"]}.`;

/**
 * Pull a JSON object out of a model response. Tolerates fenced
 * markdown, leading/trailing prose, and bare JSON. Throws
 * `decision_model_returned_non_json` (re-classified by
 * `classifyDecisionError` to `schema_parse`) when there is no
 * JSON in the response.
 *
 * Exported for unit tests so they can exercise the same
 * extractor the production code path uses.
 */
export function parseJsonObjectFromText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("decision_model_returned_non_json");
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (fenced) {
      try {
        return JSON.parse(fenced);
      } catch {
        // fall through to brace extraction below
      }
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        throw new Error("decision_model_returned_non_json");
      }
    }
    throw new Error("decision_model_returned_non_json");
  }
}

/**
 * Map a thrown error from any decision rung into the closed
 * `DecisionErrorType` discriminator. The function inspects the
 * message string (the AI SDK, Codex CLI, and our own helpers
 * all raise with a recognizable prefix); it never logs the raw
 * error. Exported for unit tests.
 */
export function classifyDecisionError(err: unknown): {
  type: DecisionErrorType;
  messageSafe: string;
} {
  const raw = err instanceof Error ? err.message : String(err);
  // Codex CLI helpers — see lib/codex/runner.ts. The runner
  // raises these strings verbatim; we surface them with a
  // stable discriminator so the UI never has to grep messages.
  if (/codex usage limit reached/i.test(raw)) {
    return { type: "usage_limit", messageSafe: "Codex usage limit reached." };
  }
  if (/not logged in|401 unauthorized|missing bearer|api key not set/i.test(raw)) {
    return { type: "auth", messageSafe: "Codex auth failed: not logged in." };
  }
  if (/429 too many requests|rate.?limit(ed)?/i.test(raw)) {
    return { type: "network", messageSafe: "Rate limit hit." };
  }
  if (/unknown model|model not found|model .* not supported/i.test(raw)) {
    return { type: "provider_disabled", messageSafe: "Model id not supported." };
  }
  // Our own thrown errors — keep them greppable so future
  // debugging can attribute the failure quickly.
  if (raw === "decision_model_returned_non_json") {
    return { type: "schema_parse", messageSafe: "Model did not return JSON." };
  }
  if (raw.startsWith("decision_parse_failed:")) {
    return { type: "schema_parse", messageSafe: raw };
  }
  if (raw.startsWith("decision_schema_validation_failed:")) {
    return { type: "schema_validation", messageSafe: raw };
  }
  if (raw === "decision_empty_output") {
    return { type: "empty_output", messageSafe: "Model returned an empty response." };
  }
  if (/codex_cli_not_installed|invalid_codex_recommender_model/.test(raw)) {
    return {
      type: "provider_configuration_error",
      messageSafe: "Codex CLI is not configured on this server.",
    };
  }
  // ProviderConfigurationError is raised by the runtime when
  // MINIMAX_API_KEY is missing or when a codex providerId
  // somehow reaches the chat-runtime path. Surface the type
  // directly without exposing the secret.
  if (/ProviderConfigurationError|MINIMAX_API_KEY|OPENAI_API_KEY/i.test(raw)) {
    return {
      type: "provider_configuration_error",
      messageSafe: "Provider is not configured (missing API key).",
    };
  }
  // AI SDK structured-output wrapper raises these. They mean
  // the model returned JSON that didn't conform to the schema.
  if (/No object generated/i.test(raw)) {
    if (/could not parse the response/i.test(raw)) {
      return { type: "schema_parse", messageSafe: "Model did not return JSON." };
    }
    if (/response did not match schema/i.test(raw)) {
      return { type: "schema_validation", messageSafe: "Model returned JSON that did not match the schema." };
    }
    return { type: "schema_validation", messageSafe: "Model output failed validation." };
  }
  return { type: "unknown", messageSafe: raw };
}

async function runCodexDecision(args: {
  modelId: string;
  system: string;
  user: string;
}): Promise<DecisionOutput> {
  const binary = resolveCodexBinary();
  if (!binary) throw new Error("codex_cli_not_installed");
  const codexModelId = args.modelId.startsWith("codex:") ? args.modelId.slice(6) : args.modelId;
  if (!isCodexModelId(codexModelId)) throw new Error("invalid_codex_recommender_model");
  const schemaHint = `Return ONLY minified JSON with this shape: {"decision":"normal_chat|coding_task","reason":"short user-visible reason","ambiguity":"low|medium|high","signals":["short signal"]}. No markdown, no code fences.`;
  const result = await runCodexExec(binary, `${args.system}\n\n${schemaHint}\n\n${args.user}`, {
    model: codexModelId,
    maxPromptLength: 16_000,
  });
  if (!result.ok) throw new Error(result.error);
  const parsed = parseJsonObjectFromText(result.responseText);
  try {
    return outputSchema.parse(parsed);
  } catch (zodErr) {
    const issues =
      zodErr instanceof z.ZodError
        ? zodErr.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")
        : String(zodErr);
    throw new Error(`decision_schema_validation_failed: ${issues}`);
  }
}

/**
 * Non-Codex decision rung. We do NOT use the AI SDK
 * `Output.object({ schema })` helper here because MiniMax in
 * particular does not honor the strict response_format
 * parameter — the provider either ignores it or wraps the JSON
 * in conversational text, and the helper fails with
 * "No object generated". Instead we ask for strict JSON in the
 * system prompt, then parse + validate explicitly so the failure
 * modes are attributable.
 */
async function runNonCodexDecision(args: {
  resolved: ResolvedModel;
  system: string;
  user: string;
  reasoningProviderOptions: ReturnType<typeof getRuntimeProviderOptions>;
}): Promise<DecisionOutput> {
  const result = await generateText({
    model: getRuntimeModel(args.resolved),
    system: args.system,
    prompt: args.user,
    stopWhen: stepCountIs(1),
    ...(args.reasoningProviderOptions ? { providerOptions: args.reasoningProviderOptions } : {}),
  });
  const text = (result.text ?? "").trim();
  if (text.length === 0) throw new Error("decision_empty_output");
  let parsed: unknown;
  try {
    parsed = parseJsonObjectFromText(text);
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : String(parseErr);
    throw new Error(`decision_parse_failed: ${detail}`);
  }
  try {
    return outputSchema.parse(parsed);
  } catch (zodErr) {
    const issues =
      zodErr instanceof z.ZodError
        ? zodErr.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")
        : String(zodErr);
    throw new Error(`decision_schema_validation_failed: ${issues}`);
  }
}

function buildDecisionPrompt(message: string) {
  return {
    system: DECISION_SYSTEM_PROMPT,
    user: JSON.stringify({ prompt: message }),
    /**
     * Strict-JSON instruction suffix appended to the system
     * prompt for non-Codex providers (OpenAI, MiniMax). Codex
     * CLI uses its own schemaHint appended inline.
     */
    nonCodexJsonOnlySuffix: NON_CODEX_JSON_ONLY_SUFFIX,
  };
}

/**
 * Walk the configured chain and return both the structured
 * decision AND the per-rung failure trace. We always record
 * every rung (attempted: true|false) so the UI can distinguish
 * "fallback not configured" from "fallback attempted and failed"
 * from "fallback skipped because primary succeeded". The chain
 * is exactly the configured rungs (max 2); we never append a
 * hidden third default rung.
 *
 * The function returns success when any rung produces a valid
 * decision. When no rung succeeds it throws with a non-secret
 * combined message; the structured per-rung details are still
 * available on the `attempts` array.
 */
async function runModelDecision(
  input: z.infer<typeof decideSchema>,
  chain: ConfiguredRecommenderRung[],
): Promise<{
  value: DecisionOutput;
  recommenderModelId: string;
  attempts: RungAttempt[];
}> {
  const prompt = buildDecisionPrompt(input.message);
  const attempts: RungAttempt[] = [];

  for (let i = 0; i < chain.length; i++) {
    const rung = chain[i]!;
    const resolved = resolveModel(rung.modelId);
    if (!resolved.ok) {
      // The configured model id cannot be resolved — record the
      // attempt as failed and CONTINUE to the next rung. This
      // mirrors the recommender-chain walker's contract: never
      // `break`, never append a third default.
      attempts.push({
        source: rung.source,
        modelId: rung.modelId,
        providerId: providerPathFromResolveError(rung.modelId),
        attempted: true,
        succeeded: false,
        errorType: resolved.error.kind === "provider_disabled" ? "provider_disabled" : "unknown",
        errorMessageSafe: resolved.error.kind,
      });
      continue;
    }

    try {
      const providerOptions = (() => {
        if (rung.reasoningLevel === undefined) return undefined;
        const meta = getModelMeta(resolved.resolved.modelId);
        const capability = meta?.reasoningCapability ?? UNKNOWN_REASONING_CAPABILITY;
        return getRuntimeProviderOptions({
          resolved: resolved.resolved,
          capability,
          reasoningOption: rung.reasoningLevel,
        });
      })();

      const value =
        resolved.resolved.providerId === "codex"
          ? await runCodexDecision({ modelId: resolved.resolved.modelId, ...prompt })
          : await runNonCodexDecision({
              resolved: resolved.resolved,
              system: `${prompt.system}${prompt.nonCodexJsonOnlySuffix}`,
              user: prompt.user,
              reasoningProviderOptions: providerOptions,
            });

      // Record the success of THIS rung; do not record anything
      // for the trailing rungs that we never walk to (the chain
      // walker caps at 2 — see `buildConfiguredRecommenderChain`).
      // `succeeded: true` + null errorType tells the UI that this
      // rung produced a valid decision.
      attempts.push({
        source: rung.source,
        modelId: resolved.resolved.modelId,
        providerId: resolved.resolved.providerId,
        attempted: true,
        succeeded: true,
        errorType: "unknown",
        errorMessageSafe: null,
      });
      return { value, recommenderModelId: resolved.resolved.modelId, attempts };
    } catch (err) {
      const classified = classifyDecisionError(err);
      attempts.push({
        source: rung.source,
        modelId: rung.modelId,
        providerId: resolved.resolved.providerId,
        attempted: true,
        succeeded: false,
        errorType: classified.type,
        errorMessageSafe: classified.messageSafe,
      });
      // CONTINUE to the next rung. Never `break`.
    }
  }

  // No rung produced a decision. The two-rung cap means the
  // chain has either 1 or 2 rungs; if we only have 1 the second
  // slot is reported as `attempted: false` so the UI can show
  // "no fallback configured" rather than "fallback failed".
  if (chain.length < 2) {
    attempts.push({
      source: "configured_fallback",
      modelId: "<none-configured>",
      providerId: "unknown",
      attempted: false,
      succeeded: false,
      errorType: "not_attempted",
      errorMessageSafe: "No fallback recommender is configured.",
    });
  }

  throw new DecisionChainError(
    attempts.length > 0
      ? attempts.map((a) => `${a.modelId}: ${a.errorType}`).join("; ")
      : "Router decision failed. No recommender model is configured.",
    attempts,
  );
}

class DecisionChainError extends Error {
  readonly attempts: RungAttempt[];
  constructor(message: string, attempts: RungAttempt[]) {
    super(message);
    this.name = "DecisionChainError";
    this.attempts = attempts;
  }
}

function providerPathFromResolveError(modelId: string): "openai" | "codex" | "minimax" | "unknown" {
  if (modelId.startsWith("codex:")) return "codex";
  if (modelId.startsWith("minimax:") || modelId.startsWith("MiniMax-")) return "minimax";
  if (modelId === "unknown") return "unknown";
  return "openai";
}

/**
 * Build the wire-shape `error_details` object from the per-rung
 * trace. Always populated — even on success — so the UI knows
 * which model made the decision. Exported for unit tests so the
 * shape contract is pinned.
 *
 * Semantic contract for each rung:
 *   - `primary_error_type: null` + `primary_error_message_safe: null`
 *     means primary SUCCEEDED (no failure to report). The
 *     `recommender_model_id` field on the response tells the UI
 *     which rung actually produced the decision.
 *   - `primary_error_type: "<type>"` + `primary_error_message_safe: "<msg>"`
 *     means primary FAILED with that discriminator and sanitized
 *     message. The fallback slot then tells the user what
 *     happened next.
 *   - Fallback slot has three states:
 *     1. `fallback_attempted: false` + `fallback_error_type: "not_attempted"`
 *        + `fallback_error_message_safe: "No fallback recommender is configured."`
 *        — no fallback configured.
 *     2. `fallback_attempted: true` + `fallback_error_type: null` —
 *        fallback succeeded. The `recommender_model_id` field
 *        identifies it.
 *     3. `fallback_attempted: true` + `fallback_error_type: "<type>"` —
 *        fallback failed; the user must pick a manual route.
 */
export function buildErrorDetails(args: {
  chain: ReadonlyArray<ConfiguredRecommenderRung>;
  attempts: ReadonlyArray<RungAttempt>;
  finalSource: DecisionSource;
}): DecisionErrorDetails {
  const primaryRung = args.chain[0];
  const fallbackRung = args.chain[1];
  // The attempt list might contain a synthetic "not_attempted"
  // fallback record (added when no fallback was configured). We
  // match by source to keep the lookup unambiguous.
  const primaryAttempt = primaryRung
    ? args.attempts.find((a) => a.source === primaryRung.source && primaryRung.source === "configured")
    : undefined;
  const fallbackAttempt = fallbackRung
    ? args.attempts.find((a) => a.source === fallbackRung.source)
    : undefined;

  const fallbackModelId = fallbackRung?.modelId ?? null;
  const fallbackProviderId: "openai" | "codex" | "minimax" | "unknown" | null = fallbackRung
    ? providerPathFromResolveError(fallbackRung.modelId)
    : null;

  // Primary slot: null when primary succeeded; classifier when
  // primary failed; null when no primary was configured.
  const primaryFailed =
    primaryAttempt && primaryAttempt.attempted && !primaryAttempt.succeeded;
  const primaryErrorType: DecisionErrorType | null = primaryFailed
    ? primaryAttempt.errorType
    : null;
  const primaryErrorMessageSafe: string | null = primaryFailed
    ? primaryAttempt.errorMessageSafe
    : null;

  // Fallback slot: three states as documented above.
  let fallbackAttempted: boolean;
  let fallbackErrorType: DecisionErrorType | null;
  let fallbackErrorMessageSafe: string | null;
  if (!fallbackRung) {
    fallbackAttempted = false;
    fallbackErrorType = "not_attempted";
    fallbackErrorMessageSafe = "No fallback recommender is configured.";
  } else if (fallbackAttempt && fallbackAttempt.attempted && fallbackAttempt.succeeded) {
    fallbackAttempted = true;
    fallbackErrorType = null;
    fallbackErrorMessageSafe = null;
  } else if (fallbackAttempt && fallbackAttempt.attempted) {
    fallbackAttempted = true;
    fallbackErrorType = fallbackAttempt.errorType;
    fallbackErrorMessageSafe = fallbackAttempt.errorMessageSafe;
  } else {
    // Fallback was configured but not attempted — this happens
    // when the primary succeeded so the chain walker stopped
    // before reaching it.
    fallbackAttempted = false;
    fallbackErrorType = "not_attempted";
    fallbackErrorMessageSafe = "Primary succeeded; fallback was not attempted.";
  }

  return {
    primary_recommender_model_id: primaryRung?.modelId ?? null,
    primary_provider_path: primaryRung
      ? providerPathFromResolveError(primaryRung.modelId)
      : "unknown",
    primary_error_type: primaryErrorType,
    primary_error_message_safe: primaryErrorMessageSafe,
    fallback_recommender_model_id: fallbackModelId,
    fallback_provider_path: fallbackProviderId,
    fallback_attempted: fallbackAttempted,
    fallback_error_type: fallbackErrorType,
    fallback_error_message_safe: fallbackErrorMessageSafe,
    final_decision_source: args.finalSource,
  };
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsedAction = actionSchema.safeParse(body);
  if (parsedAction.success) {
    await updateDecisionRun({ id: parsedAction.data.runId, ...parsedAction.data });
    return Response.json({ ok: true });
  }

  const parsed = decideSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const settings = await getEffectiveRouterSettings();
  const chain = buildConfiguredRecommenderChain(settings);

  const telemetryModelId = chain[0]?.modelId ?? "unknown";
  const estimate = await estimateRecommendation({
    recommenderModelId: telemetryModelId,
    providerPath: chain[0]?.providerId ?? "unknown",
    promptTokenEstimate: Math.max(1, Math.ceil(parsed.data.message.length / 4)),
    contextTokenEstimate: 0,
    stepId: "router_decision",
  });
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  let output: DecisionOutput | null = null;
  let source: DecisionSource = "model";
  let recommenderModelId: string | null = null;
  let attempts: RungAttempt[] = [];
  let thrownError: unknown = null;

  try {
    const result = await runModelDecision(parsed.data, chain);
    output = result.value;
    recommenderModelId = result.recommenderModelId;
    attempts = [...result.attempts];
  } catch (err) {
    source = "manual_after_model_error";
    thrownError = err;
    if (err instanceof DecisionChainError) {
      attempts = [...err.attempts];
    } else {
      // Unhandled error path — record it as an unknown failure
      // for the primary rung so the UI always sees structured
      // error_details.
      const classified = classifyDecisionError(err);
      attempts = [
        {
          source: "configured",
          modelId: chain[0]?.modelId ?? "unknown",
          providerId: chain[0]
            ? providerPathFromResolveError(chain[0].modelId)
            : "unknown",
          attempted: true,
          succeeded: false,
          errorType: classified.type,
          errorMessageSafe: classified.messageSafe,
        },
      ];
    }
  }

  const errorDetails = buildErrorDetails({
    chain,
    attempts,
    finalSource: source,
  });

  const completedAt = new Date().toISOString();
  const actual = Date.now() - startedAtMs;
  const latency = latencyOutcome(actual, estimate.expectedLatencyMs, estimate.upperLatencyMs);
  // The DB error_json column is jsonb; we store the same
  // structured object the API returns so log/dashboard queries
  // can filter by `error_details.primary_error_type` etc. The
  // raw thrown error is intentionally not persisted (its message
  // may carry provider internals); `errorMessageSafe` is the
  // sanitized form on `attempts`.
  const errorJsonForDb: unknown = !output
    ? {
        error_details: errorDetails,
        attempts,
        rawMessage: thrownError instanceof Error ? thrownError.message : thrownError != null ? String(thrownError) : null,
      }
    : null;
  const runId = await createDecisionRun({
    threadId: parsed.data.threadId ?? null,
    projectId: parsed.data.projectId ?? null,
    promptHash: promptHash(parsed.data.message.trim()),
    promptText: parsed.data.message.trim(),
    decision: output?.decision ?? null,
    reason: output?.reason ?? null,
    estimateQuality: estimate.estimateQuality,
    expectedLatencyMs: estimate.expectedLatencyMs,
    upperLatencyMs: estimate.upperLatencyMs,
    startedAt,
    completedAt,
    actualLatencyMs: actual,
    latencyDeviationMs: latency.deviationMs,
    latencyDeviationPct: latency.deviationPct,
    decisionSource: source,
    recommenderModelId,
    ambiguity: output?.ambiguity ?? null,
    signalsJson: output?.signals ?? null,
    errorJson: errorJsonForDb,
  });

  if (!output) {
    return Response.json({
      runId,
      decision: null,
      // Keep the user-facing reason short and stable; the
      // structured `error_details` block carries the per-rung
      // breakdown so the chat composer can render specifics.
      reason: "Router decision failed.",
      ambiguity: null,
      signals: [],
      decision_source: source,
      recommender_model_id: recommenderModelId,
      error_details: errorDetails,
      attempts,
      error: {
        message:
          thrownError instanceof Error ? thrownError.message : String(thrownError ?? "unknown"),
      },
      expected_latency_ms: estimate.expectedLatencyMs,
      upper_latency_ms: estimate.upperLatencyMs,
      estimate_quality: estimate.estimateQuality,
      started_at: startedAt,
      completed_at: completedAt,
      actual_latency_ms: actual,
    });
  }

  return Response.json({
    runId,
    decision: output.decision,
    reason: output.reason,
    ambiguity: output.ambiguity,
    signals: output.signals,
    decision_source: source,
    recommender_model_id: recommenderModelId,
    // Always include `error_details` so the client can render
    // the per-rung breakdown for diagnostics. On a SUCCESS the
    // primary slot reports null errorType (primary succeeded)
    // and the fallback slot reports `not_attempted` (chain
    // walker stopped after primary). When primary FAILED but
    // fallback SUCCEEDED, `error_details` carries the primary
    // failure and a `fallback_attempted: true, fallback_error_type: null`
    // marker for the active rung — the user can see exactly
    // which model produced the decision.
    error_details: errorDetails,
    attempts,
    expected_latency_ms: estimate.expectedLatencyMs,
    upper_latency_ms: estimate.upperLatencyMs,
    estimate_quality: estimate.estimateQuality,
    started_at: startedAt,
    completed_at: completedAt,
    actual_latency_ms: actual,
  });
}