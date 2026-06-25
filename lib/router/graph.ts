/**
 * LangGraph router graph.
 *
 * This is the lightweight router AGENTS.md asks for: a small, deterministic
 * state machine with one LLM call inside it. There are no tool calls, no
 * memory, no agent loop, no vector store — just five small nodes that
 * prepare a prompt, resolve the allowlist, call GPT-5.4 Mini with a Zod
 * structured-output schema, validate the response, and apply the budget
 * guard. Anything that goes wrong falls back to `pickFallback`.
 *
 * The graph is compiled once at module load and reused per request — there
 * is no per-call compilation overhead.
 *
 * We use `@langchain/langgraph` (the low-level StateGraph) — we do not pull
 * in `langchain`, `createAgent`, `langchain-openai`, etc. The only OpenAI
 * touchpoint is `openai(modelId)` from `@ai-sdk/openai`, which is the
 * same AI SDK 6 binding the rest of the app uses.
 */
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { openai } from "@ai-sdk/openai";
import { getDefaultRouterModelId } from "@/lib/providers";
import { ROUTER_OWN_REASONING_LEVEL } from "@/lib/providers/openai";
import {
  applyBudgetGuard,
  isInAllowedPool,
  pickFallback,
  resolveAllowedPool,
  validateRouterOutput,
  type RouterRecommendation,
  type RouterSideCombo,
} from "@/lib/router/policy";
import type { RouterAllowlistEntry } from "@/lib/providers/types";
import type { RouterSettings } from "@/lib/router/schema";
import { getRouterSettings } from "@/lib/router/schema";
import { buildRouterPrompt, type RouterRecentTurn } from "@/lib/router/prompts";
import { recommend } from "@/lib/router/llm-recommend";

export type RouterGraphInput = {
  /** The most recent user text. Used as the primary signal for the recommender. */
  latestUserText: string;
  /**
   * Up to 3 most-recent turns (role + short text excerpt). Used as light
   * context. The router never sees the full thread history, notes, or any
   * persisted metadata.
   */
  recentTurns: ReadonlyArray<RouterRecentTurn>;
  /** Side A combo the user picked. */
  sideA: RouterSideCombo;
  /**
   * Total chars in the latest user text + recent turns. Used by the long-prompt
   * safety guard.
   */
  recentChars: number;
  /**
   * Per-call override of settings. Defaults to `getRouterSettings()` from env.
   * Useful for tests and for the future settings UI.
   */
  settingsOverride?: RouterSettings;
};

export type RouterGraphOutput = {
  /** Side B combo to use, or `null` if Side B was skipped (budget or fallback-empty). */
  sideB: RouterSideCombo | null;
  /** Validated router recommendation, if the LLM produced one. */
  recommendation: RouterRecommendation | null;
  /** True when the router output was rejected or it threw and we used a fallback. */
  usedFallback: boolean;
  /** Reason we fell back, when usedFallback=true. Persisted for observability. */
  fallbackReason: string | null;
  /** Human-readable reason Side B was skipped. Surfaced in the UI. */
  skipReason: string | null;
  /** Combined estimated cost in USD, including the router call. */
  estimatedCostUsd: number;
  /** Settings used for this run, returned for the chat route to persist on the session row. */
  settingsUsed: RouterSettings;
};

// ---------------------------------------------------------------------------
// Graph state
// ---------------------------------------------------------------------------

const RouterState = Annotation.Root({
  // Inputs
  latestUserText: Annotation<string>(),
  recentTurns: Annotation<ReadonlyArray<RouterRecentTurn>>(),
  sideA: Annotation<RouterSideCombo>(),
  recentChars: Annotation<number>(),
  settings: Annotation<RouterSettings>(),

  // Computed by `prepare_input` and `build_allowed_pool`
  promptUser: Annotation<string>(),
  promptSystem: Annotation<string>(),
  allowlist: Annotation<ReadonlyArray<RouterAllowlistEntry>>(),

  // `llm_recommend` outputs
  rawOutput: Annotation<unknown>(),
  routerError: Annotation<string | null>(),

  // `resolve_recommendation` outputs
  recommendation: Annotation<RouterRecommendation | null>(),
  sideBPicked: Annotation<RouterSideCombo | null>(),
  usedFallback: Annotation<boolean>(),
  fallbackReason: Annotation<string | null>(),

  // `apply_budget` outputs
  sideBFinal: Annotation<RouterSideCombo | null>(),
  skipReason: Annotation<string | null>(),
  estimatedCostUsd: Annotation<number>(),
});

type RouterStateShape = typeof RouterState.State;

// ---------------------------------------------------------------------------
// Node: prepare_input
// ---------------------------------------------------------------------------

function prepareInput(_state: RouterStateShape): Partial<RouterStateShape> {
  // No real work here yet — the prompt is built in `build_allowed_pool`
  // because we need the allowlist to render the prompt. We only ensure
  // defaults so the next node can run unconditionally.
  return {
    promptSystem: "",
    promptUser: "",
    allowlist: [],
  };
}

// ---------------------------------------------------------------------------
// Node: build_allowed_pool
// ---------------------------------------------------------------------------

function buildAllowedPool(state: RouterStateShape): Partial<RouterStateShape> {
  const pool = resolveAllowedPool(state.settings, state.recentChars);
  const { system, user } = buildRouterPrompt({
    latestUserText: state.latestUserText,
    recentTurns: state.recentTurns,
    allowlist: pool,
    maxCostPerRecommendationUsd: state.settings.maxCostPerRecommendationUsd,
  });
  return {
    allowlist: pool,
    promptSystem: system,
    promptUser: user,
  };
}

// ---------------------------------------------------------------------------
// Node: llm_recommend
// ---------------------------------------------------------------------------

async function llmRecommendNode(state: RouterStateShape): Promise<Partial<RouterStateShape>> {
  // `abEnabled=false` short-circuits to "no recommendation", which downstream
  // nodes will turn into a skipped B side.
  if (!state.settings.abEnabled) {
    return {
      rawOutput: null,
      routerError: "router disabled by settings",
      recommendation: null,
      sideBPicked: null,
      usedFallback: false,
      fallbackReason: null,
    };
  }
  if (state.allowlist.length === 0) {
    return {
      rawOutput: null,
      routerError: "router allowlist is empty",
      recommendation: null,
      sideBPicked: null,
      usedFallback: false,
      fallbackReason: null,
    };
  }
  const modelId = state.settings.routerModelId || getDefaultRouterModelId();
  const model = openai(modelId) as unknown as Parameters<typeof recommend>[0]["model"];
  const signal = AbortSignal.timeout(5_000);
  // The router uses low reasoning effort regardless of the user's selection —
  // we want the recommender to be cheap and fast.
  void ROUTER_OWN_REASONING_LEVEL;
  const result = await recommend({
    model,
    system: state.promptSystem,
    user: state.promptUser,
    signal,
  });
  if (!result.ok) {
    return {
      rawOutput: null,
      routerError: result.reason,
      recommendation: null,
      sideBPicked: null,
      usedFallback: false,
      fallbackReason: null,
    };
  }
  return {
    rawOutput: result.raw,
    routerError: null,
    recommendation: null, // validation happens in the next node
    sideBPicked: null,
    usedFallback: false,
    fallbackReason: null,
  };
}

// ---------------------------------------------------------------------------
// Node: resolve_recommendation
// ---------------------------------------------------------------------------

function resolveRecommendationNode(state: RouterStateShape): Partial<RouterStateShape> {
  // The recommender returned no output at all → fall back to pool cheapest.
  if (state.routerError) {
    const fallback = pickFallback(state.allowlist);
    return {
      recommendation: null,
      sideBPicked: fallback,
      usedFallback: true,
      fallbackReason: state.routerError,
    };
  }
  const validation = validateRouterOutput(state.rawOutput, state.allowlist);
  if (!validation.ok) {
    const fallback = pickFallback(state.allowlist);
    return {
      recommendation: null,
      sideBPicked: fallback,
      usedFallback: true,
      fallbackReason: validation.reason,
    };
  }
  const rec = validation.value;
  const combo: RouterSideCombo = {
    modelId: rec.recommendedModel,
    reasoningLevel: rec.recommendedReasoningLevel,
  };
  // Defense in depth: even if validation passed, double-check membership.
  if (!isInAllowedPool(combo, state.allowlist)) {
    const fallback = pickFallback(state.allowlist);
    return {
      recommendation: null,
      sideBPicked: fallback,
      usedFallback: true,
      fallbackReason: "recommendation failed allowlist membership check",
    };
  }
  return {
    recommendation: rec,
    sideBPicked: combo,
    usedFallback: false,
    fallbackReason: null,
  };
}

// ---------------------------------------------------------------------------
// Node: apply_budget
// ---------------------------------------------------------------------------

function applyBudgetNode(state: RouterStateShape): Partial<RouterStateShape> {
  // Master kill-switch: when A/B is disabled, do not run Side B even if a
  // fallback was computed upstream. The router layer reports
  // `routerError === "router disabled by settings"` in this case, but we
  // also short-circuit here so the budget guard cannot accidentally let a
  // fallback through when the user has A/B turned off entirely.
  if (!state.settings.abEnabled) {
    return {
      sideBFinal: null,
      skipReason: state.fallbackReason ?? "router disabled by settings",
      estimatedCostUsd: 0,
    };
  }
  const sideBPicked = state.sideBPicked;
  if (!sideBPicked) {
    return {
      sideBFinal: null,
      skipReason: state.fallbackReason ?? "no side B picked",
      estimatedCostUsd: 0,
    };
  }
  const decision = applyBudgetGuard(state.sideA, sideBPicked, state.settings, state.recentChars);
  if (!decision.keepB) {
    return {
      sideBFinal: null,
      skipReason: decision.reason,
      estimatedCostUsd: decision.estimatedCostUsd,
    };
  }
  return {
    sideBFinal: decision.combo,
    skipReason: null,
    estimatedCostUsd: decision.estimatedCostUsd,
  };
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

function buildGraph() {
  const workflow = new StateGraph(RouterState)
    .addNode("prepare_input", prepareInput)
    .addNode("build_allowed_pool", buildAllowedPool)
    .addNode("llm_recommend", llmRecommendNode)
    .addNode("resolve_recommendation", resolveRecommendationNode)
    .addNode("apply_budget", applyBudgetNode)
    .addEdge(START, "prepare_input")
    .addEdge("prepare_input", "build_allowed_pool")
    .addEdge("build_allowed_pool", "llm_recommend")
    .addEdge("llm_recommend", "resolve_recommendation")
    .addEdge("resolve_recommendation", "apply_budget")
    .addEdge("apply_budget", END);
  return workflow.compile();
}

// Module-scope compiled graph — re-used per request. Safe because none of the
// nodes mutate module-scope state; they only read from the passed-in state.
const compiledGraph = buildGraph();

/**
 * Run the router graph with the given input and return a typed output.
 *
 * Never throws — even if every node fails, we always return a populated
 * `RouterGraphOutput` with `sideB: null` and a descriptive `skipReason`.
 */
export async function runRouterGraph(input: RouterGraphInput): Promise<RouterGraphOutput> {
  const settings = input.settingsOverride ?? getRouterSettings();
  const state: RouterStateShape = {
    latestUserText: input.latestUserText,
    recentTurns: input.recentTurns,
    sideA: input.sideA,
    recentChars: input.recentChars,
    settings,
    promptSystem: "",
    promptUser: "",
    allowlist: [],
    rawOutput: null,
    routerError: null,
    recommendation: null,
    sideBPicked: null,
    usedFallback: false,
    fallbackReason: null,
    sideBFinal: null,
    skipReason: null,
    estimatedCostUsd: 0,
  };
  let result: RouterStateShape;
  try {
    const out = await compiledGraph.invoke(state);
    result = out as RouterStateShape;
  } catch (err) {
    // Catastrophic graph failure → still answer with Side A and skip B.
    const reason = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error("[router/graph] graph invocation failed:", reason);
    return {
      sideB: null,
      recommendation: null,
      usedFallback: false,
      fallbackReason: null,
      skipReason: `router graph failed: ${reason}`,
      estimatedCostUsd: 0,
      settingsUsed: settings,
    };
  }
  return {
    sideB: result.sideBFinal,
    recommendation: result.recommendation,
    usedFallback: result.usedFallback,
    fallbackReason: result.fallbackReason,
    skipReason: result.skipReason,
    estimatedCostUsd: result.estimatedCostUsd,
    settingsUsed: settings,
  };
}
