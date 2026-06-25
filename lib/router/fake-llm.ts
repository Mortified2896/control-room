/**
 * Deterministic "fake LLM" stub for development and Playwright runs.
 *
 * Why this exists:
 *   - The brief requires AI SDK 6 + LangGraph + an actual structured-output
 *     call to GPT-5.4 Mini. That call costs real money.
 *   - For local iteration and the Playwright E2E spec, we want the full
 *     router → Side A → Side B → persistence → panel → feedback pipeline
 *     to exercise end-to-end without spending tokens.
 *
 * Activation:
 *   Set `CONTROL_ROOM_FAKE_LLM=1` in the process env. Both the chat route
 *   (`streamText` for Side A and `generateText` for Side B) and the router
 *   recommender (`recommend` in `lib/router/llm-recommend.ts`) detect the
 *   flag at call time and route through the stubs below.
 *
 * What the stubs return:
 *   - Side A (`streamText`): a short, deterministic assistant paragraph
 *     that mentions the model + reasoning level it was "called" with.
 *   - Side B (`generateText`): another short paragraph with a slightly
 *     different angle so the side-by-side panel has two distinct texts.
 *   - Router (`recommend`): a structured recommendation that picks a
 *     combo deterministically from the allowlist based on the prompt text
 *     (heuristic: code/debug → medium reasoning, long prompt → medium,
 *     otherwise low). This exercises the validation + budget + persistence
 *     paths without involving an LLM.
 *
 * Production safety:
 *   When the flag is unset, the stubs are inert — every code path goes
 *   through the real AI SDK. We deliberately do NOT cache fake responses
 *   across runs; each call gets a fresh deterministic response based on
 *   its inputs.
 */
import type { RouterAllowlistEntry } from "@/lib/providers/types";
import { isInAllowedPool } from "@/lib/router/policy";

export function isFakeLlmEnabled(): boolean {
  return process.env.CONTROL_ROOM_FAKE_LLM === "1";
}

/**
 * Fake Side A / Side B assistant text.
 *
 * Deterministic per (modelId, reasoningLevel) so the panel renders the same
 * text on every reload during a single Playwright run.
 */
export function fakeAssistantText(opts: {
  side: "A" | "B";
  modelId: string;
  reasoningLevel: string;
  userPrompt: string;
}): string {
  const { side, modelId, reasoningLevel, userPrompt } = opts;
  const cleaned = userPrompt.replace(/\s+/g, " ").trim().slice(0, 120);
  const lead =
    side === "A"
      ? `I'm answering as **${modelId}** with **${reasoningLevel}** reasoning — your selected combo.`
      : `I'm answering as **${modelId}** with **${reasoningLevel}** reasoning — the router's recommendation.`;
  const tail =
    side === "A"
      ? "Side A preserves the exact model + reasoning level you picked in the picker."
      : "Side B uses the model + reasoning level the cheap GPT-5.4 Mini recommender picked for this prompt.";
  return `${lead} To your prompt — "${cleaned}" — here is the angle I'd take.\n\n${tail}\n\n(This is a deterministic stub response — set CONTROL_ROOM_FAKE_LLM=0 to call the real model.)`;
}

/**
 * Heuristic fake router recommendation. Mirrors what a real GPT-5.4 Mini
 * call would do: scan the prompt for keywords + length and pick a combo
 * from the allowlist. The "router says" sentence is generated from the
 * picked combo so the panel UI has realistic text to render.
 *
 * Important: this function MUST only emit values that pass
 * `isInAllowedPool(pool)` for the pool it is called with. The chat route
 * and the router graph both gate this stub through the same validation +
 * budget pipeline as the real LLM path.
 */
export function fakeRouterRecommendation(opts: {
  userPrompt: string;
  allowlist: ReadonlyArray<RouterAllowlistEntry>;
}): {
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
  const { userPrompt, allowlist } = opts;
  const text = userPrompt.toLowerCase();

  const wantsHighReasoning =
    /\b(debug|debugging|stack\s*trace|refactor|architect|complex|hard|production)\b/.test(text);
  const wantsMediumReasoning =
    /\b(code|coding|implement|write\s+(a|an)\s+(function|script|class|program)|explain\s+how|tutorial|guide|how\s+to)\b/.test(
      text,
    );
  const isLong = userPrompt.length >= 600;

  let preferredLevel: "low" | "medium" | "high" = "low";
  if (wantsHighReasoning) preferredLevel = "high";
  else if (wantsMediumReasoning || isLong) preferredLevel = "medium";

  // Find the cheapest combo in the allowlist that matches the preferred
  // level; if none, fall back to the cheapest combo overall.
  const exact = allowlist.filter((e) => e.reasoningLevel === preferredLevel);
  const candidates = exact.length > 0 ? exact : [...allowlist];
  if (candidates.length === 0) {
    // Should never happen — the chat route skips Side B entirely when the
    // pool is empty. We return a placeholder that fails validation so the
    // caller falls back to the deterministic cheapest picker.
    return {
      recommended_model: "__no_allowlist__",
      recommended_reasoning_level: "low",
      confidence: 0,
      task_type: "other",
      short_reason: "no allowlist",
    };
  }
  candidates.sort((a, b) => a.modelId.localeCompare(b.modelId));
  const picked = candidates[0];
  // Confirm the pick is actually in the pool (defense in depth). If not,
  // pick the first entry that IS in the pool.
  const poolEntry = isInAllowedPool(
    { modelId: picked.modelId, reasoningLevel: picked.reasoningLevel },
    allowlist,
  )
    ? picked
    : allowlist[0];
  if (!poolEntry) {
    return {
      recommended_model: "__no_allowlist__",
      recommended_reasoning_level: "low",
      confidence: 0,
      task_type: "other",
      short_reason: "no allowlist",
    };
  }

  const taskType =
    wantsHighReasoning && /\bdebug\b/.test(text)
      ? "debugging"
      : wantsHighReasoning && /\b(code|coding|implement)\b/.test(text)
        ? "coding"
        : wantsMediumReasoning
          ? "writing"
          : "simple_chat";

  return {
    recommended_model: poolEntry.modelId,
    recommended_reasoning_level: poolEntry.reasoningLevel,
    confidence: 0.5 + (preferredLevel === "low" ? 0.1 : preferredLevel === "medium" ? 0.2 : 0.3),
    task_type: taskType,
    short_reason: `Picked ${poolEntry.modelId} with ${poolEntry.reasoningLevel} reasoning because the prompt looks like a ${
      taskType === "simple_chat" ? "short conversational turn" : taskType
    }.`,
  };
}
