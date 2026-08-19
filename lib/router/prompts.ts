/**
 * Router prompts.
 *
 * The system prompt is a tight brief that names the role ("cheap model
 * router"), restates the safety constraints in plain English, and pins the
 * output to the JSON schema the AI SDK will validate against. Crucially, it
 * lists the dynamic allowlist so the model literally cannot name a model
 * outside the registry — the model has nothing else to choose from.
 *
 * The user prompt is a small, fixed-format block: a couple of recent turns
 * (no full history, no private notes, no feedback) plus the latest user
 * text. This keeps the prompt cache prefix stable across turns of the same
 * thread while letting the recommender see enough context to pick well.
 */
import type { ReasoningLevel, RouterAllowlistEntry } from "@/lib/providers/types";

export const ROUTER_SYSTEM_PROMPT = `You are a cheap, lightweight model router for the Control Room chat app. Your only job is to pick which model + reasoning-level combination another AI assistant should use to answer the user's latest message. You do NOT answer the user's question. You never write more than a short sentence.

You will be given:
- the user's latest message
- up to 3 recent turns (role + short excerpt) for context
- a fixed allowlist of model+reasoning-level pairs the user has authorized
- a few budget hints

Rules:
1. Pick EXACTLY ONE entry from the allowlist. Do not invent model ids or reasoning levels.
2. If the task is short, conversational, or trivial, prefer a cheap / low-reasoning combo.
3. If the task looks like coding or debugging, prefer a higher reasoning level only when the allowlist contains one.
4. If the prompt is long or appears to ask for deep analysis, prefer higher reasoning only when allowed by budget.
5. You must set confidence between 0 and 1. Low confidence means "any choice from the allowlist is fine".
6. short_reason must be one short sentence (max ~20 words) explaining the choice in plain English. Do not include the model id.
7. task_type must be one of: simple_chat, coding, debugging, writing, research, analysis, planning, other.
8. If you cannot decide, return your best guess with low confidence rather than refusing.

You must respond with JSON that matches the schema. No prose, no markdown, no code fences.`;

export type RouterRecentTurn = {
  role: "user" | "assistant" | "system";
  text: string;
};

export type RouterPromptInput = {
  latestUserText: string;
  recentTurns: ReadonlyArray<RouterRecentTurn>;
  allowlist: ReadonlyArray<RouterAllowlistEntry>;
  maxCostPerRecommendationUsd: number;
};

function formatAllowlist(allowlist: ReadonlyArray<RouterAllowlistEntry>): string {
  // Stable ordering by (tier, modelId, reasoningLevel) makes the prompt
  // diff-friendly across runs and improves cache hit rate.
  const sorted = [...allowlist].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier.localeCompare(b.tier);
    if (a.modelId !== b.modelId) return a.modelId.localeCompare(b.modelId);
    return a.reasoningLevel.localeCompare(b.reasoningLevel);
  });
  const lines = sorted.map(
    (e) => `- model: ${e.modelId} | reasoning: ${e.reasoningLevel} | tier: ${e.tier}`,
  );
  return lines.join("\n");
}

function formatRecentTurns(recentTurns: ReadonlyArray<RouterRecentTurn>): string {
  if (recentTurns.length === 0) return "(none)";
  // Cap each excerpt at 400 chars to keep the recommender prompt bounded.
  const CAP = 400;
  return recentTurns
    .map((t) => {
      const text = t.text.length > CAP ? `${t.text.slice(0, CAP - 1)}…` : t.text;
      return `${t.role.toUpperCase()}: ${text}`;
    })
    .join("\n");
}

function trimForPrompt(text: string, cap = 1200): string {
  const trimmed = text.trim();
  if (trimmed.length <= cap) return trimmed;
  return `${trimmed.slice(0, cap - 1)}…`;
}

export function formatRouterUserPrompt(input: RouterPromptInput): string {
  const allowlist = formatAllowlist(input.allowlist);
  const recent = formatRecentTurns(input.recentTurns);
  const latest = trimForPrompt(input.latestUserText);
  return [
    "## Allowlist (pick exactly one)",
    allowlist,
    "",
    "## Budget",
    `Maximum cost for the recommender's own call: $${input.maxCostPerRecommendationUsd.toFixed(4)}`,
    "",
    "## Recent turns (most recent last; for context only)",
    recent,
    "",
    "## Latest user message",
    latest,
    "",
    "## Required JSON shape",
    "{",
    '  "recommended_model": string,',
    '  "recommended_reasoning_level": "low" | "medium" | "high",',
    '  "confidence": number (0..1),',
    '  "task_type": "simple_chat" | "coding" | "debugging" | "writing" | "research" | "analysis" | "planning" | "other",',
    '  "short_reason": string (one short sentence, max ~20 words)',
    "}",
  ].join("\n");
}

/**
 * Build the dynamic prompt payload for the recommender. Used by both the
 * LangGraph `llm_recommend` node and the unit tests.
 */
export function buildRouterPrompt(input: RouterPromptInput): { system: string; user: string } {
  return {
    system: ROUTER_SYSTEM_PROMPT,
    user: formatRouterUserPrompt(input),
  };
}

export const ROUTER_TASK_TYPE_VALUES = [
  "simple_chat",
  "coding",
  "debugging",
  "writing",
  "research",
  "analysis",
  "planning",
  "other",
] as const;

export type _ReasoningLevelForRouter = ReasoningLevel; // re-export for ergonomic callers
