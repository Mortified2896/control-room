import "server-only";

import type { ContextDecision } from "./routing-decision-panel-types";
import type { ConfiguredRecommenderRung } from "./recommender-config";

/**
 * System prompt body for the new context-decision classifier.
 *
 * The brief lists explicit positive / negative examples for both
 * `chat_only` and `harness_needed`. The prompt is written so the
 * classifier returns ONLY the new enums (`chat_only` /
 * `harness_needed`); the legacy `/api/router/decision` route
 * consumes this prompt via a thin mapping line so the two routes
 * share one classifier prompt.
 *
 * Critical: the prompt must NOT bias the classifier toward
 * "coding task" framing. The whole point of the new enum is to
 * distinguish "needs repo/file access" from "general
 * conversational / explanatory". Many non-coding prompts (e.g.
 * "Do we have an AGENTS.md?") still require repo access and
 * must map to `harness_needed`.
 *
 * `None of the above is hard-coded to a specific router model
 * id — the prompt is model-agnostic. The recommended execution
 * model is selected by the SEPARATE model-pick recommender, not
 * by this classifier.
 */
export const CONTEXT_DECISION_SYSTEM_PROMPT = `Classify the user's prompt as either "chat_only" or "harness_needed".

Use "harness_needed" when the prompt requires inspecting, reading, listing, opening, summarizing, or modifying files, directories, code, configs, environment variables, dependencies, build/test/typecheck/lint output, runtime logs, settings, schemas, or any resource that lives inside the current project / repository / working tree. The harness has the file access; normal chat does not.

Use "chat_only" for general conversational prompts, conceptual explanations, brainstorming, translation, summarization of knowledge already in the model, definitions, "what is X" questions, planning discussion without explicit file inspection or change, and model-routing discussion only.

Examples that MUST classify as "harness_needed":
- "Do we have an AGENTS.md?"
- "What is inside AGENTS.md?"
- "Where is the router implemented?"
- "Which env vars does this project need?"
- "Why is the build failing?"
- "Can you change the settings page?"
- "Where is the database schema defined?"
- "List the files under lib/router."
- "Show me the diff of the last commit."
- "Why is typecheck red?"
- "Open the package.json and tell me the version."

Examples that MUST classify as "chat_only":
- "What is TypeScript?"
- "Explain what AGENTS.md usually is"
- "What does routing mean in general?"
- "Help me think through this idea without checking files"
- "Translate this paragraph to Spanish."
- "Summarize the abstract."
- "What is a LangGraph state machine?"

Ambiguous cases: prefer "chat_only" unless the prompt CLEARLY needs repository / workspace inspection or modification. The user can correct the decision.

Return a single JSON object: {"decision":"chat_only|harness_needed","explanation":"<=200 chars, user-visible"}.
- "decision" must be EXACTLY "chat_only" or "harness_needed".
- "explanation" must be 1 short sentence in plain English naming the dominant signal (e.g. "Asks whether a project file exists, so normal chat is not enough.").`;

/**
 * JSON-only suffix appended to the system prompt for non-Codex
 * providers (OpenAI, MiniMax). The Codex CLI uses its own
 * `schemaHint` appended inline. Mirrors the pattern in
 * `app/api/router/decision/route.ts`.
 */
export const CONTEXT_DECISION_JSON_ONLY_SUFFIX = `

Respond with a single JSON object matching this exact shape:
{"decision":"chat_only|harness_needed","explanation":"<=200 chars"}.

Rules:
- No markdown, no code fences, no commentary, no trailing text.
- The first character of your response MUST be "{".
- The last character of your response MUST be "}".
- Use only the enum values shown above for "decision".`;

/**
 * Output shape returned by the classifier. Mirrors the brief's
 * panel `contextDecision` block. The route's panel builder
 * turns this directly into the wire payload.
 */
export type ClassifierOutput = {
  decision: ContextDecision;
  /** 1-sentence user-visible explanation (max 200 chars). */
  explanation: string;
};

/**
 * The classifier's classified rung-trace. Mirrors
 * `RungAttempt` in `app/api/router/decision/route.ts` so the UI
 * can show the same per-rung breakdown on a classifier failure
 * (without ever exposing the recommender model id as an
 * execution model).
 */
export type ClassifierRungAttempt = {
  source: "configured" | "configured_fallback";
  modelId: string;
  attempted: boolean;
  succeeded: boolean;
  reason: string | null;
};

/**
 * The keyword regex used by `DECISION_KEYWORD_FALLBACK`. The
 * regex is intentionally conservative: we trigger
 * `harness_needed` only when the message CLEARLY mentions a
 * project / workspace / repo / file / debug signal.
 *
 * Phrases like "explain what AGENTS.md usually is" do NOT
 * trigger `harness_needed` because they are a general-knowledge
 * question about the file format, not a request to inspect the
 * project. The brief's `chat_only` example "Explain what
 * AGENTS.md usually is" is the canary for that distinction —
 * so the regex looks for project-context phrasing ("do we
 * have", "inside the", "in this repo", etc.) AND for explicit
 * project-state signals ("build failing", "env vars", "type
 * error", …). A bare mention of "AGENTS.md" alone is not
 * enough — that pattern catches "Explain what AGENTS.md
 * usually is" as chat-only correctly.
 */
const HARNESS_KEYWORDS =
  /\b(?:do we have|is there (?:an?|the)|are there|where is\b|where are|inside (?:the |[A-Z]|\d)|in this (?:repo|project|codebase|directory|workspace|working tree)|in the (?:repo|project|codebase|directory|workspace|working tree)|read the (?:file|config|schema|setting|README|AGENTS\.md|package\.json|tsconfig|lockfile)|open the (?:file|config|schema|setting|README|AGENTS\.md|package\.json|tsconfig|lockfile)|list the (?:files?|directories?|contents?)|show (?:me )?the (?:file|contents?|code|diff|logs?|output|README|AGENTS\.md|package\.json|tsconfig)|change the|modify the|edit the|update the (?:setting|config|page)|can you change|can you modify|can you edit|build (?:is )?failing|build failure|stack trace|tests? (?:are )?failing|test failure|type error|lint(?:ing)? (?:error|failure)|formatter error|env(?:ironment)? vars?|env(?:ironment)? variables?|this (?:repo|project|codebase)|current (?:repo|project|codebase)|my (?:repo|project|codebase))/i;

/**
 * Deterministic keyword-based fallback used when the LLM
 * classifier is unavailable, refused, or returned a non-JSON
 * payload. The regex is run against the lower-cased message;
 * matches are case-insensitive.
 *
 * Returns a one-sentence explanation naming the dominant
 * signal so the panel still has a visible "why" line.
 */
export function DECISION_KEYWORD_FALLBACK(message: string): ClassifierOutput {
  const trimmed = message.trim();
  if (HARNESS_KEYWORDS.test(trimmed)) {
    // Try to extract the matched signal for a short explanation.
    const match = trimmed.match(HARNESS_KEYWORDS);
    const signal = match ? match[0] : "project context";
    return {
      decision: "harness_needed",
      explanation: `Mentions project context (${signal}); normal chat cannot inspect the repository.`,
    };
  }
  return {
    decision: "chat_only",
    explanation: "No project-context signals detected; normal chat is sufficient.",
  };
}

/**
 * Choose the classifier lane for a request.
 *
 * - `"deterministic"` when the message is very short (<40 chars,
 *   unlikely to have meaningful signals) OR very long (>4000
 *   chars, JSON output risk for the LLM classifier) OR when no
 *   recommender chain is configured.
 * - `"llm"` otherwise.
 *
 * The deterministic lane is ALWAYS available even when no
 * recommender model is configured; the LLM lane REQUIRES the
 * recommender chain so the classifier can be paired with a
 * model.
 */
export function selectClassifierLane(args: {
  message: string;
  chainLength: number;
}): "deterministic" | "llm" {
  const len = args.message.trim().length;
  if (args.chainLength === 0) return "deterministic";
  if (len === 0) return "deterministic";
  if (len < 40) return "deterministic";
  if (len > 4000) return "deterministic";
  return "llm";
}

/**
 * The closure signature used by `classifyContextDecision` to
 * actually call the model. The default implementation lives in
 * the route file; tests pass a stub to assert behavior without
 * a real model.
 */
export type ClassifierRunRung = (args: {
  rung: ConfiguredRecommenderRung;
  system: string;
  user: string;
}) => Promise<ClassifierOutput>;

/**
 * Run the classifier. Mirrors the recommender chain walker:
 *
 * - For each rung in `chain` (max 2 rungs), attempt to call the
 *   model via `runRung`. On failure, continue to the next rung.
 *   Never `break`, never append a hidden third default rung.
 * - The first rung that produces a parseable JSON output
 *   matching `decision ∈ {"chat_only", "harness_needed"}` is
 *   the active result.
 * - If every rung fails OR the chain is empty, fall back to
 *   `DECISION_KEYWORD_FALLBACK(message)` so the panel always
 *   has a result. The fallback NEVER throws.
 *
 * The classifier and the model-pick recommender share the same
 * configured chain so a user who disables / removes the
 * recommender also disables the classifier. The brief: "any
 * of the configured chain rungs can run it".
 */
export async function classifyContextDecision(args: {
  message: string;
  chain: ReadonlyArray<ConfiguredRecommenderRung>;
  runRung: ClassifierRunRung;
}): Promise<{
  value: ClassifierOutput;
  attempts: ReadonlyArray<ClassifierRungAttempt>;
  source: "llm" | "deterministic";
}> {
  const prompt = {
    system: `${CONTEXT_DECISION_SYSTEM_PROMPT}${CONTEXT_DECISION_JSON_ONLY_SUFFIX}`,
    user: JSON.stringify({ prompt: args.message }),
  };

  const attempts: ClassifierRungAttempt[] = [];
  for (const rung of args.chain) {
    try {
      const value = await args.runRung({ rung, ...prompt });
      if (value && (value.decision === "chat_only" || value.decision === "harness_needed")) {
        attempts.push({
          source: rung.source,
          modelId: rung.modelId,
          attempted: true,
          succeeded: true,
          reason: null,
        });
        return { value, attempts, source: "llm" };
      }
      attempts.push({
        source: rung.source,
        modelId: rung.modelId,
        attempted: true,
        succeeded: false,
        reason: "invalid_classifier_output",
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      attempts.push({
        source: rung.source,
        modelId: rung.modelId,
        attempted: true,
        succeeded: false,
        reason,
      });
      // CONTINUE to the next rung. Never break.
    }
  }

  // No rung succeeded (or the chain was empty). The keyword
  // fallback is always available so the panel never blocks on
  // the classifier.
  const value = DECISION_KEYWORD_FALLBACK(args.message);
  return { value, attempts, source: "deterministic" };
}

/**
 * Map the new `chat_only` / `harness_needed` enum onto the
 * legacy `normal_chat` / `coding_task` enum for the
 * `/api/router/decision` route. The two enums are NOT
 * identical: `chat_only` → `normal_chat`, `harness_needed` →
 * `coding_task`. The mapping is the single point where the two
 * shapes are reconciled.
 *
 * The legacy route uses this mapping so it can keep its
 * `decision: z.enum(["normal_chat", "coding_task"])` schema
 * without rewriting its tests.
 */
export function mapContextDecisionToLegacy(d: ContextDecision): "normal_chat" | "coding_task" {
  return d === "harness_needed" ? "coding_task" : "normal_chat";
}

/**
 * Inverse of `mapContextDecisionToLegacy`. Used when the panel
 * needs to hydrate from a legacy decision record (e.g. on a
 * hard reload where the user had previously approved a coding
 * route).
 */
export function mapLegacyToContextDecision(d: "normal_chat" | "coding_task"): ContextDecision {
  return d === "coding_task" ? "harness_needed" : "chat_only";
}