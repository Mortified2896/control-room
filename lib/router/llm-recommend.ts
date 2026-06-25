/**
 * Thin wrapper around the AI SDK structured-output call used by the router.
 *
 * Why a wrapper:
 * - Centralizes the AI SDK v6 `Output.object({ schema })` pattern in one
 *   place so the graph node stays declarative.
 * - Allows the unit tests to stub the call without pulling in a mocking
 *   framework (see the `recommendImpl` swap in `lib/router/graph.test.ts`).
 *
 * Contract:
 * - `recommend(...)` MUST NOT throw on validation failures. The AI SDK may
 *   throw on schema-parsing errors; we catch and return a `RouterRecommendResult`
 *   with `ok: false` and a stringified reason.
 * - `recommend(...)` MUST honor `signal` so callers can put a hard
 *   wall-clock cap on the router call (the chat route uses 5 seconds).
 * - `recommend(...)` MUST use `stepCountIs(1)` so the model doesn't loop.
 * - The schema is the one declared in this module; callers do not pass it.
 */
import { generateText, Output, stepCountIs, type LanguageModel } from "ai";
import { z } from "zod/v4";
import type { RouterRecommendation } from "@/lib/router/policy";
import { ROUTER_TASK_TYPE_VALUES } from "@/lib/router/prompts";
import { fakeRouterRecommendation, isFakeLlmEnabled } from "@/lib/router/fake-llm";

const routerRecommendationSchema = z.object({
  recommended_model: z.string().min(1).max(120),
  recommended_reasoning_level: z.enum(["low", "medium", "high"]),
  confidence: z.number().min(0).max(1),
  task_type: z.enum(ROUTER_TASK_TYPE_VALUES),
  short_reason: z.string().min(1).max(240),
});

export type RouterRecommendArgs = {
  model: LanguageModel;
  system: string;
  user: string;
  signal?: AbortSignal;
};

export type RouterRecommendResult =
  | { ok: true; value: RouterRecommendation; raw: unknown }
  | { ok: false; reason: string };

/**
 * Module-scope seam for tests. Production code calls `recommend`; tests
 * reassign `recommendImpl` to a stub and then call `recommend(...)`.
 */
export type RecommendImpl = (args: RouterRecommendArgs) => Promise<RouterRecommendResult>;

const defaultRecommendImpl: RecommendImpl = async (args) => {
  // Cheap fake-LLM mode for development + Playwright runs. The structured
  // output schema is bypassed; we hand-build a snake_case payload that
  // matches the schema so `validateRouterOutput` accepts it identically.
  if (isFakeLlmEnabled()) {
    const fake = fakeRouterRecommendationFromPrompt(args.user);
    return {
      ok: true,
      value: snakeCaseToCamel(fake),
      raw: fake,
    };
  }
  try {
    const result = await generateText({
      model: args.model,
      system: args.system,
      prompt: args.user,
      output: Output.object({
        schema: routerRecommendationSchema,
        name: "router_recommendation",
        description:
          "Structured recommendation for Side B (model + reasoning level + short reason).",
      }),
      stopWhen: stepCountIs(1),
      abortSignal: args.signal,
    });
    const value = result.output;
    if (value == null) {
      return { ok: false, reason: "router output was empty" };
    }
    // Map snake_case from the schema into our camelCase RouterRecommendation.
    const v = value as {
      recommended_model?: string;
      recommended_reasoning_level?: string;
      confidence?: number;
      task_type?: string;
      short_reason?: string;
    };
    return {
      ok: true,
      value: {
        recommendedModel: v.recommended_model ?? "",
        recommendedReasoningLevel:
          (v.recommended_reasoning_level as RouterRecommendation["recommendedReasoningLevel"]) ??
          "low",
        confidence: v.confidence ?? 0,
        taskType: (v.task_type as RouterRecommendation["taskType"]) ?? "other",
        shortReason: v.short_reason ?? "",
      },
      raw: value,
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
};

let recommendImpl: RecommendImpl = defaultRecommendImpl;

/**
 * Extract the latest user text from the router user prompt. The prompt is
 * built by `lib/router/prompts.ts`; the "Latest user message" section is
 * a known marker we can grep for.
 */
function extractLatestUserTextFromPrompt(prompt: string): string {
  const marker = "## Latest user message";
  const idx = prompt.lastIndexOf(marker);
  if (idx === -1) return "";
  return prompt.slice(idx + marker.length).trim();
}

/**
 * Build a fake router recommendation using the prompt text. The allowlist
 * is not passed in here because `fakeRouterRecommendation` only needs the
 * user text + the caller's pool — the chat route / graph filters the pool
 * down to the resolved allowlist before calling us. To keep this stub
 * self-contained, we always pick from the cheap-tier default pool; the
 * downstream `validateRouterOutput` will still reject any disallowed pick.
 */
function fakeRouterRecommendationFromPrompt(prompt: string): {
  recommended_model: string;
  recommended_reasoning_level: "low" | "medium" | "high";
  confidence: number;
  task_type:
    | "simple_chat"
    | "coding"
    | "debugging"
    | "writing"
    | "research"
    | "analysis"
    | "planning"
    | "other";
  short_reason: string;
} {
  const userText = extractLatestUserTextFromPrompt(prompt);
  // Use the cheap-tier default pool as the universe for the fake.
  // The graph's `validateRouterOutput` runs after us and will reject any
  // pick that isn't in the actual allowlist (e.g. when expensive models
  // are disabled).
  const pool: ReadonlyArray<import("@/lib/providers/types").RouterAllowlistEntry> = [
    { modelId: "gpt-5.4-mini", reasoningLevel: "low", tier: "cheap" },
    { modelId: "gpt-5.4-mini", reasoningLevel: "medium", tier: "cheap" },
    { modelId: "gpt-5.5", reasoningLevel: "low", tier: "expensive" },
    { modelId: "gpt-5.5", reasoningLevel: "medium", tier: "expensive" },
    { modelId: "gpt-5.5", reasoningLevel: "high", tier: "expensive" },
  ];
  return fakeRouterRecommendation({ userPrompt: userText, allowlist: pool });
}

function snakeCaseToCamel(raw: {
  recommended_model: string;
  recommended_reasoning_level: string;
  confidence: number;
  task_type: string;
  short_reason: string;
}): RouterRecommendation {
  return {
    recommendedModel: raw.recommended_model,
    recommendedReasoningLevel:
      raw.recommended_reasoning_level as RouterRecommendation["recommendedReasoningLevel"],
    confidence: raw.confidence,
    taskType: raw.task_type as RouterRecommendation["taskType"],
    shortReason: raw.short_reason,
  };
}

/**
 * Test-only seam. Production code calls `recommend`; tests reassign the
 * underlying implementation via `setRecommendImpl`.
 */
export function setRecommendImpl(impl: RecommendImpl): void {
  recommendImpl = impl;
}

/**
 * Reset to the default implementation. Used by tests after they stub
 * `recommendImpl` so other tests don't leak state.
 */
export function __resetRecommendImplForTests(): void {
  recommendImpl = defaultRecommendImpl;
}

export async function recommend(args: RouterRecommendArgs): Promise<RouterRecommendResult> {
  return recommendImpl(args);
}
