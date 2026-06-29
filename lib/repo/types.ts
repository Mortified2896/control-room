/**
 * Row shapes for the v1 read-only API.
 *
 * Mirrors the proposed Postgres schema in `docs/POSTGRES_PLAN.md`. These types
 * are used by both the server (route handlers) and any future client that
 * wants to consume the data; they are intentionally minimal and JSON-safe.
 *
 * `messages.parts` is the AI SDK v6 `UIMessage.parts` shape (unknown JSON).
 */

export type ThreadMode = "chat" | "coding_task";
export type ThreadHarness = "pi" | "codex" | "opencode";

export type ThreadRow = {
  id: string;
  title: string;
  projectId: string | null;
  threadMode: ThreadMode;
  harness: ThreadHarness | null;
  modelId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectRow = {
  id: string;
  name: string;
  localPath: string;
  gitRemoteUrl: string | null;
  gitBranch: string | null;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
};

export type MessageRole = "user" | "assistant" | "system";
export type MessageRating = "up" | "down";

export type MessageRow = {
  id: string;
  threadId: string;
  role: MessageRole;
  content: string | null;
  parts: unknown;
  modelId: string | null;
  createdAt: string;
  rating?: MessageRating | null;
};

export type ThreadNoteRow = {
  threadId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Router A/B mode (migration 0004_router_ab.sql)
// ---------------------------------------------------------------------------

export type AbFeedbackRating = "prefer_a" | "prefer_b" | "tie" | "bad_router";

export const AB_FEEDBACK_RATINGS: ReadonlyArray<AbFeedbackRating> = [
  "prefer_a",
  "prefer_b",
  "tie",
  "bad_router",
];

export type AbTaskType =
  | "simple_chat"
  | "coding"
  | "debugging"
  | "writing"
  | "research"
  | "analysis"
  | "planning"
  | "other";

export type AbSide = "a" | "b";

/**
 * One row in `router_ab_sessions`. Nullable columns reflect "Side B was
 * skipped / not generated" or "the router never produced a recommendation".
 */
export type AbSessionRow = {
  id: string;
  threadId: string;
  userMessageId: string | null;
  assistantMessageId: string | null;
  sideAModelId: string;
  /**
   * Provider-native reasoning-effort value (e.g. `"low"`, `"medium"`,
   * `"xhigh"`, `"none"`, `"minimal"`). The chat composer sends the
   * raw value verbatim and the runtime adapter validates it
   * against the model's `reasoningCapability.options`. The DB column
   * is plain `text` with a non-empty CHECK — see migration
   * `0014_router_ab_provider_native_reasoning.sql`.
   */
  sideAReasoningLevel: string;
  sideBModelId: string | null;
  /** Provider-native reasoning-effort value, or `null` if Side B did not run. */
  sideBReasoningLevel: string | null;
  taskType: AbTaskType | null;
  confidence: number | null;
  shortReason: string | null;
  usedFallback: boolean;
  fallbackReason: string | null;
  skipReason: string | null;
  costEstimateUsd: number | null;
  userPromptText: string;
  recentChars: number;
  poolKeyHash: string | null;
  routerModelId: string;
  sideBText: string | null;
  sideBLatencyMs: number | null;
  createdAt: string;
  updatedAt: string;
};

export type AbFeedbackRow = {
  abSessionId: string;
  rating: AbFeedbackRating;
  createdAt: string;
  updatedAt: string;
};
