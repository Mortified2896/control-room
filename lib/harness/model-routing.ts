import type { ConfiguredRecommenderRung } from "@/lib/router/recommender-config";
import type { ModelOption } from "@/lib/providers/types";
import { providerIdFromRecommenderModelId } from "@/lib/router/recommender-config";
import type { HarnessFailureKind, HarnessId, HarnessStatusSnapshot } from "./registry";
import { HARNESS_REGISTRY, stripHarnessModelPrefix } from "./registry";

export const DEFAULT_CODING_RECOMMENDER_MODEL_ID = "codex:gpt-5.5" as const;
export const LONG_CONTEXT_CODING_RECOMMENDER_MODEL_ID = "codex:gpt-5.5" as const;
export const MINIMAX_RECOMMENDER_FALLBACK_MODEL_ID = "MiniMax-M3" as const;

// Legacy aliases kept for settings/tests that still import the old names.
// These are recommender-engine ids now, not execution-model defaults.
export const STANDARD_CODING_MODEL_ID = DEFAULT_CODING_RECOMMENDER_MODEL_ID;
export const LARGE_CONTEXT_CODING_MODEL_ID = LONG_CONTEXT_CODING_RECOMMENDER_MODEL_ID;
export const MINIMAX_FALLBACK_MODEL_ID = MINIMAX_RECOMMENDER_FALLBACK_MODEL_ID;

export const largeContextThresholdTokens = 120_000;

export const CODING_MODEL_FALLBACK_REASONS = ["usage_limit", "rate_limit", "internal"] as const;
export type CodingModelFallbackReason = (typeof CODING_MODEL_FALLBACK_REASONS)[number];

export type CodingModelRoutingPolicy = {
  /** Default-lane primary recommender engine id. Legacy name preserved. */
  standardModelId: string;
  /** Long-prompt-lane primary recommender engine id. Legacy name preserved. */
  largeContextModelId: string;
  /** Default-lane paired fallback recommender engine id. Legacy name preserved. */
  defaultRouteFallbackModelId: string | null;
  /** Long-prompt-lane paired fallback recommender engine id. Legacy name preserved. */
  largeContextRouteFallbackModelId: string | null;
  largeContextThresholdTokens: number;
  enabledFallbackReasons: ReadonlyArray<CodingModelFallbackReason>;
};

export const DEFAULT_CODING_MODEL_ROUTING_POLICY: CodingModelRoutingPolicy = {
  standardModelId: DEFAULT_CODING_RECOMMENDER_MODEL_ID,
  largeContextModelId: LONG_CONTEXT_CODING_RECOMMENDER_MODEL_ID,
  defaultRouteFallbackModelId: MINIMAX_RECOMMENDER_FALLBACK_MODEL_ID,
  largeContextRouteFallbackModelId: MINIMAX_RECOMMENDER_FALLBACK_MODEL_ID,
  largeContextThresholdTokens,
  enabledFallbackReasons: CODING_MODEL_FALLBACK_REASONS,
};

export function getCodingModelRoutingPolicy(): CodingModelRoutingPolicy {
  const raw = process.env.CONTROL_ROOM_CODING_MODEL_ROUTING;
  if (!raw) return DEFAULT_CODING_MODEL_ROUTING_POLICY;
  try {
    return parseCodingModelRoutingPolicy(JSON.parse(raw));
  } catch (err) {
    console.warn("[coding-model-routing] invalid CONTROL_ROOM_CODING_MODEL_ROUTING; using defaults", err);
    return DEFAULT_CODING_MODEL_ROUTING_POLICY;
  }
}

export async function getEffectiveCodingModelRoutingPolicy(): Promise<CodingModelRoutingPolicy> {
  const { getPersistedCodingModelRoutingSettings, settingsToCodingPolicy } = await import("@/lib/repo/coding-model-routing-settings");
  const persisted = await getPersistedCodingModelRoutingSettings();
  if (persisted) return settingsToCodingPolicy(persisted);
  return getCodingModelRoutingPolicy();
}

export function parseCodingModelRoutingPolicy(value: unknown): CodingModelRoutingPolicy {
  if (!value || typeof value !== "object") return DEFAULT_CODING_MODEL_ROUTING_POLICY;
  const v = value as Record<string, unknown>;
  const rawThreshold = typeof v.largeContextThresholdTokens === "number" ? v.largeContextThresholdTokens : v.thresholdTokens;
  const threshold = typeof rawThreshold === "number" && Number.isFinite(rawThreshold) && rawThreshold > 0
    ? Math.floor(rawThreshold)
    : largeContextThresholdTokens;
  const legacyFallback = v.failureFallbackModelId === null ? null : nonEmptyString(v.failureFallbackModelId);
  return {
    standardModelId: nonEmptyString(v.defaultRouteRecommenderModel) ?? nonEmptyString(v.defaultRouteModel) ?? nonEmptyString(v.standardModelId) ?? DEFAULT_CODING_RECOMMENDER_MODEL_ID,
    largeContextModelId: nonEmptyString(v.longPromptRouteRecommenderModel) ?? nonEmptyString(v.largeContextRouteModel) ?? nonEmptyString(v.largeContextModelId) ?? LONG_CONTEXT_CODING_RECOMMENDER_MODEL_ID,
    defaultRouteFallbackModelId: v.defaultRouteFallbackModelId === null || v.defaultRouteFallbackModel === null ? null : (nonEmptyString(v.defaultRouteFallbackRecommenderModel) ?? nonEmptyString(v.defaultRouteFallbackModelId) ?? nonEmptyString(v.defaultRouteFallbackModel) ?? legacyFallback ?? MINIMAX_RECOMMENDER_FALLBACK_MODEL_ID),
    largeContextRouteFallbackModelId: v.largeContextRouteFallbackModelId === null || v.largeContextRouteFallbackModel === null ? null : (nonEmptyString(v.longPromptRouteFallbackRecommenderModel) ?? nonEmptyString(v.largeContextRouteFallbackModelId) ?? nonEmptyString(v.largeContextRouteFallbackModel) ?? legacyFallback ?? MINIMAX_RECOMMENDER_FALLBACK_MODEL_ID),
    largeContextThresholdTokens: threshold,
    enabledFallbackReasons: parseFallbackReasons(v.fallbackReasons ?? v.enabledFallbackReasons),
  };
}

export type TokenCountMetadata = {
  requestTokens: number;
  approximate: boolean;
  method: "exact" | "approximate_chars_div_3_with_20pct_margin";
  largeContextThresholdTokens: number;
  policy: CodingModelRoutingPolicy;
};

export type CodingRecommenderLane = "default" | "long-prompt";

export type CodingHarnessCandidate = {
  harnessId: HarnessId;
  harnessLabel: string;
  providerPath: string;
  billingPath: string;
  status: "available" | "unavailable" | "unknown";
  unavailableReason: string | null;
  supportsReasoningLevels: boolean;
  modelId: string;
  reasoningLevel: string;
};

export type RequestPayloadForTokenCount = {
  systemDeveloperRouterInstructions?: string;
  currentUserPrompt: string;
  selectedProjectContextFiles?: Array<unknown>;
  includedThreadHistory?: Array<unknown>;
  retrievedSnippets?: Array<unknown>;
  harnessMetadata?: unknown;
};

export function buildRequestPayloadForTokenCount(args: {
  instruction: string;
  candidates?: unknown;
  harnessMetadata?: unknown;
  threadHistory?: unknown;
  projectContext?: unknown;
  retrievedSnippets?: unknown;
}): RequestPayloadForTokenCount {
  return {
    systemDeveloperRouterInstructions:
      "Control Room coding harness routing: deterministic metadata may choose only the recommender lane; the configured recommender engine must choose the harness, execution model, reasoning level, and explanations from authorized candidates. Router/recommender engines and their fallbacks are decision engines only and must never be execution defaults.",
    currentUserPrompt: args.instruction,
    selectedProjectContextFiles: normalizeUnknownArray(args.projectContext),
    includedThreadHistory: normalizeUnknownArray(args.threadHistory),
    retrievedSnippets: normalizeUnknownArray(args.retrievedSnippets),
    harnessMetadata: args.harnessMetadata ?? args.candidates ?? null,
  };
}

export function computeRequestTokenCount(payload: RequestPayloadForTokenCount, policy: CodingModelRoutingPolicy = DEFAULT_CODING_MODEL_ROUTING_POLICY): TokenCountMetadata {
  const serialized = JSON.stringify(payload);
  const approximate = Math.ceil((serialized.length / 3) * 1.2);
  return {
    requestTokens: approximate,
    approximate: true,
    method: "approximate_chars_div_3_with_20pct_margin",
    largeContextThresholdTokens: policy.largeContextThresholdTokens,
    policy,
  };
}

export function selectCodingRecommenderLane(args: {
  payload: RequestPayloadForTokenCount;
  policy?: CodingModelRoutingPolicy;
}): { lane: CodingRecommenderLane; tokenCount: TokenCountMetadata; primary: ConfiguredRecommenderRung; fallback: ConfiguredRecommenderRung | null } {
  const policy = args.policy ?? DEFAULT_CODING_MODEL_ROUTING_POLICY;
  const tokenCount = computeRequestTokenCount(args.payload, policy);
  const lane: CodingRecommenderLane = tokenCount.requestTokens > policy.largeContextThresholdTokens ? "long-prompt" : "default";
  const primaryModelId = lane === "long-prompt" ? policy.largeContextModelId : policy.standardModelId;
  const fallbackModelId = lane === "long-prompt" ? policy.largeContextRouteFallbackModelId : policy.defaultRouteFallbackModelId;
  return {
    lane,
    tokenCount,
    primary: {
      source: "configured",
      providerId: providerIdFromRecommenderModelId(primaryModelId),
      modelId: primaryModelId,
      reasoningLevel: "low",
    },
    fallback: fallbackModelId
      ? {
          source: "configured_fallback",
          providerId: providerIdFromRecommenderModelId(fallbackModelId),
          modelId: fallbackModelId,
          reasoningLevel: "low",
        }
      : null,
  };
}

export function buildCodingHarnessCandidates(
  snapshots: ReadonlyArray<Pick<HarnessStatusSnapshot, "id" | "status" | "unavailableReason" | "failureKind">>,
): CodingHarnessCandidate[] {
  return buildCodingHarnessCandidatesFromModels([], snapshots);
}

export function buildCodingHarnessCandidatesFromModels(
  models: ReadonlyArray<ModelOption>,
  snapshots: ReadonlyArray<Pick<HarnessStatusSnapshot, "id" | "status" | "unavailableReason" | "failureKind">>,
): CodingHarnessCandidate[] {
  const snapshotById = new Map(snapshots.map((s) => [s.id, s] as const));
  const out: CodingHarnessCandidate[] = [];
  for (const harness of HARNESS_REGISTRY) {
    const snap = snapshotById.get(harness.id);
    const status = snap?.status ?? harness.status;
    const unavailableReason = snap?.unavailableReason ?? harness.unavailableReason;
    if (status !== "available") continue;
    const target = harness.id;
    for (const model of models) {
      if (!model.enabled) continue;
      if (!(model.supportedExecutionTargets ?? []).includes(target)) continue;
      const rawModelId = stripHarnessModelPrefix(model.modelId);
      const reasoningLevels = harness.supportsReasoningLevels && model.reasoningLevels.length > 0
        ? model.reasoningLevels
        : ["provider_default"];
      for (const reasoningLevel of reasoningLevels) {
        out.push({
          harnessId: harness.id,
          harnessLabel: harness.displayName,
          providerPath: harness.providerPath,
          billingPath: harness.billingPath,
          status,
          unavailableReason,
          supportsReasoningLevels: harness.supportsReasoningLevels,
          modelId: rawModelId,
          reasoningLevel,
        });
      }
    }
  }
  return out;
}

export type CodingRecommenderOutput = {
  selectedHarness: HarnessId;
  selectedModelId: string;
  selectedReasoningLevel: string;
  harnessExplanation: string;
  modelExplanation: string;
  alternatives?: Array<{ harness: HarnessId; modelId: string; reasoningLevel: string; reason: string }>;
};

export function validateCodingRecommenderOutput(
  raw: unknown,
  candidates: ReadonlyArray<CodingHarnessCandidate>,
): { ok: true; value: CodingRecommenderOutput } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "recommender output was not an object" };
  const r = raw as Record<string, unknown>;
  const selectedHarness = r.selectedHarness ?? r.recommendedHarness;
  const selectedModelId = r.selectedModelId ?? r.recommendedModelId;
  const selectedReasoningLevel = r.selectedReasoningLevel ?? r.recommendedReasoningLevel;
  const harnessExplanation = r.harnessExplanation ?? r.whyThisHarness ?? r.reason;
  const modelExplanation = r.modelExplanation ?? r.whyThisModel;
  if (selectedHarness !== "codex_cli" && selectedHarness !== "minimax_cli") return { ok: false, reason: "missing or invalid selectedHarness" };
  if (typeof selectedModelId !== "string" || !selectedModelId.trim()) return { ok: false, reason: "missing selectedModelId" };
  if (typeof selectedReasoningLevel !== "string" || !selectedReasoningLevel.trim()) return { ok: false, reason: "missing selectedReasoningLevel" };
  if (typeof harnessExplanation !== "string" || !harnessExplanation.trim()) return { ok: false, reason: "harness explanation is required" };
  if (typeof modelExplanation !== "string" || !modelExplanation.trim()) return { ok: false, reason: "model explanation is required" };
  const modelId = stripHarnessModelPrefix(selectedModelId.trim());
  const candidate = candidates.find(
    (c) => c.harnessId === selectedHarness && c.modelId === modelId && c.reasoningLevel === selectedReasoningLevel,
  );
  if (!candidate) {
    return { ok: false, reason: `recommendation not in authorized candidates: ${selectedHarness} / ${selectedModelId} / ${selectedReasoningLevel}` };
  }
  const alternatives = Array.isArray(r.alternatives)
    ? r.alternatives
        .map((a): { harness: HarnessId; modelId: string; reasoningLevel: string; reason: string } | null => {
          if (!a || typeof a !== "object") return null;
          const o = a as Record<string, unknown>;
          const harness = o.harness;
          if (harness !== "codex_cli" && harness !== "minimax_cli") return null;
          const altModel = typeof o.modelId === "string" ? stripHarnessModelPrefix(o.modelId) : null;
          const altReasoning = typeof o.reasoningLevel === "string" ? o.reasoningLevel : null;
          const reason = typeof o.reason === "string" && o.reason.trim() ? o.reason.trim() : "Alternative authorized by recommender.";
          if (!altModel || !altReasoning) return null;
          return { harness, modelId: altModel, reasoningLevel: altReasoning, reason };
        })
        .filter((a): a is { harness: HarnessId; modelId: string; reasoningLevel: string; reason: string } => Boolean(a))
    : [];
  return {
    ok: true,
    value: {
      selectedHarness,
      selectedModelId: modelId,
      selectedReasoningLevel,
      harnessExplanation: harnessExplanation.trim(),
      modelExplanation: modelExplanation.trim(),
      alternatives,
    },
  };
}

export type CodingRecommenderCallAttempt = {
  source: "configured" | "configured_fallback";
  modelId: string;
  providerId: "openai" | "codex" | "minimax";
  reasoning: string;
  status: "success" | "failed";
  reason: string;
};

export type CodingRecommendationSuccess = {
  ok: true;
  lane: CodingRecommenderLane;
  tokenCount: TokenCountMetadata;
  recommender: ConfiguredRecommenderRung;
  fallbackConfigured: ConfiguredRecommenderRung | null;
  fallbackUsed: boolean;
  callAttempts: ReadonlyArray<CodingRecommenderCallAttempt>;
  recommendation: CodingRecommenderOutput;
};

export type CodingRecommendationBlocked = {
  ok: false;
  lane: CodingRecommenderLane;
  tokenCount: TokenCountMetadata;
  primary: ConfiguredRecommenderRung;
  fallbackConfigured: ConfiguredRecommenderRung | null;
  callAttempts: ReadonlyArray<CodingRecommenderCallAttempt>;
  reason: string;
};

export async function runCodingHarnessRecommendation(args: {
  payload: RequestPayloadForTokenCount;
  snapshots: ReadonlyArray<Pick<HarnessStatusSnapshot, "id" | "status" | "unavailableReason" | "failureKind">>;
  candidates?: ReadonlyArray<CodingHarnessCandidate>;
  policy?: CodingModelRoutingPolicy;
  runRung: (args: {
    rung: ConfiguredRecommenderRung;
    lane: CodingRecommenderLane;
    payload: RequestPayloadForTokenCount;
    candidates: ReadonlyArray<CodingHarnessCandidate>;
    tokenCount: TokenCountMetadata;
  }) => Promise<unknown>;
}): Promise<CodingRecommendationSuccess | CodingRecommendationBlocked> {
  const lane = selectCodingRecommenderLane({ payload: args.payload, policy: args.policy });
  const chain = [lane.primary, ...(lane.fallback ? [lane.fallback] : [])];
  const candidates = args.candidates ?? buildCodingHarnessCandidates(args.snapshots);
  const callAttempts: CodingRecommenderCallAttempt[] = [];
  if (candidates.length === 0) {
    return {
      ok: false,
      lane: lane.lane,
      tokenCount: lane.tokenCount,
      primary: lane.primary,
      fallbackConfigured: lane.fallback,
      callAttempts,
      reason: "No available coding harness execution candidates. No execution model selected.",
    };
  }
  for (const rung of chain) {
    try {
      const raw = await args.runRung({ rung, lane: lane.lane, payload: args.payload, candidates, tokenCount: lane.tokenCount });
      const validated = validateCodingRecommenderOutput(raw, candidates);
      if (!validated.ok) throw new Error(validated.reason);
      callAttempts.push({
        source: rung.source,
        modelId: rung.modelId,
        providerId: rung.providerId,
        reasoning: rung.reasoningLevel ?? "",
        status: "success",
        reason: "ok",
      });
      return {
        ok: true,
        lane: lane.lane,
        tokenCount: lane.tokenCount,
        recommender: rung,
        fallbackConfigured: lane.fallback,
        fallbackUsed: rung.source === "configured_fallback",
        callAttempts,
        recommendation: validated.value,
      };
    } catch (err) {
      callAttempts.push({
        source: rung.source,
        modelId: rung.modelId,
        providerId: rung.providerId,
        reasoning: rung.reasoningLevel ?? "",
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
  }
  const primary = callAttempts.find((a) => a.source === "configured");
  const fallback = callAttempts.find((a) => a.source === "configured_fallback");
  const reason = [
    primary ? `Primary recommender failed: ${primary.modelId}${primary.reasoning ? ` · ${primary.reasoning}` : ""}: ${primary.reason}.` : "Primary recommender was not attempted.",
    fallback
      ? `Fallback recommender failed: ${fallback.modelId}${fallback.reasoning ? ` · ${fallback.reasoning}` : ""}: ${fallback.reason}. No other recommender fallback will be used automatically.`
      : "No fallback recommender is configured. No other recommender fallback will be used automatically.",
    "No execution model selected; launch is blocked.",
  ].join(" ");
  return {
    ok: false,
    lane: lane.lane,
    tokenCount: lane.tokenCount,
    primary: lane.primary,
    fallbackConfigured: lane.fallback,
    callAttempts,
    reason,
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseFallbackReasons(value: unknown): ReadonlyArray<CodingModelFallbackReason> {
  if (!Array.isArray(value)) return CODING_MODEL_FALLBACK_REASONS;
  const reasons = value.filter((v): v is CodingModelFallbackReason => CODING_MODEL_FALLBACK_REASONS.includes(v as CodingModelFallbackReason));
  return Array.from(new Set(reasons));
}

function normalizeUnknownArray(value: unknown): Array<unknown> | undefined {
  if (Array.isArray(value)) return value;
  if (value == null) return undefined;
  return [value];
}

void CODING_MODEL_FALLBACK_REASONS;
void HARNESS_REGISTRY;
void stripHarnessModelPrefix;
void isRecognizedFallbackFailure;
void failureLabel;

function isRecognizedFallbackFailure(kind: HarnessFailureKind | null | undefined, policy: CodingModelRoutingPolicy): kind is CodingModelFallbackReason {
  return CODING_MODEL_FALLBACK_REASONS.includes(kind as CodingModelFallbackReason) && policy.enabledFallbackReasons.includes(kind as CodingModelFallbackReason);
}

function failureLabel(kind: "usage_limit" | "rate_limit" | "internal"): string {
  if (kind === "usage_limit") return "recent quota failure";
  if (kind === "rate_limit") return "recent rate-limit failure";
  return "recent provider failure";
}
