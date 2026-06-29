import "server-only";

import { withClient, withTransaction } from "@/lib/db";
import type { AbFeedbackRating, AbSessionRow, AbFeedbackRow, AbTaskType } from "./types";

/**
 * Repo functions for Router A/B mode.
 *
 * Read paths use `tryDb` so a missing/unavailable DB degrades gracefully.
 * Write paths throw: callers should report/handle persistence failure
 * explicitly (the chat route swallows and logs, so a DB outage doesn't
 * break the chat itself).
 *
 * Convention for UUIDs:
 * - We never generate UUIDs in app code; we always use Postgres `gen_random_uuid()`.
 * - The `RETURNING` clause on every insert gives us the row in one round-trip.
 */

type RawAbSession = {
  id: string;
  thread_id: string;
  user_message_id: string | null;
  assistant_message_id: string | null;
  side_a_model_id: string;
  side_a_reasoning_level: "low" | "medium" | "high";
  side_b_model_id: string | null;
  side_b_reasoning_level: "low" | "medium" | "high" | null;
  task_type: AbTaskType | null;
  confidence: string | number | null;
  short_reason: string | null;
  used_fallback: boolean;
  fallback_reason: string | null;
  skip_reason: string | null;
  cost_estimate_usd: string | number | null;
  user_prompt_text: string;
  recent_chars: number;
  pool_key_hash: string | null;
  router_model_id: string;
  side_b_text: string | null;
  side_b_latency_ms: number | null;
  created_at: Date;
  updated_at: Date;
};

type RawAbFeedback = {
  ab_session_id: string;
  rating: AbFeedbackRating;
  created_at: Date;
  updated_at: Date;
};

function toNumber(value: string | number | null): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toAbSessionRow(r: RawAbSession): AbSessionRow {
  return {
    id: r.id,
    threadId: r.thread_id,
    userMessageId: r.user_message_id,
    assistantMessageId: r.assistant_message_id,
    sideAModelId: r.side_a_model_id,
    sideAReasoningLevel: r.side_a_reasoning_level,
    sideBModelId: r.side_b_model_id,
    sideBReasoningLevel: r.side_b_reasoning_level,
    taskType: r.task_type,
    confidence: toNumber(r.confidence),
    shortReason: r.short_reason,
    usedFallback: r.used_fallback,
    fallbackReason: r.fallback_reason,
    skipReason: r.skip_reason,
    costEstimateUsd: toNumber(r.cost_estimate_usd),
    userPromptText: r.user_prompt_text,
    recentChars: r.recent_chars,
    poolKeyHash: r.pool_key_hash,
    routerModelId: r.router_model_id,
    sideBText: r.side_b_text,
    sideBLatencyMs: r.side_b_latency_ms,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function toAbFeedbackRow(r: RawAbFeedback): AbFeedbackRow {
  return {
    abSessionId: r.ab_session_id,
    rating: r.rating,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export type CreateAbSessionInput = {
  threadId: string;
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  sideAModelId: string;
  /** Provider-native reasoning-effort value (see `AbSessionRow.sideAReasoningLevel`). */
  sideAReasoningLevel: string;
  userPromptText: string;
  recentChars: number;
  poolKeyHash?: string | null;
  routerModelId: string;
  /** Set when Side B was decided up-front (cheaper than a second round-trip). */
  sideBModelId?: string | null;
  sideBReasoningLevel?: string | null;
  taskType?: AbTaskType | null;
  confidence?: number | null;
  shortReason?: string | null;
  usedFallback?: boolean;
  fallbackReason?: string | null;
  skipReason?: string | null;
  costEstimateUsd?: number | null;
};

/**
 * Insert a new `router_ab_sessions` row. Returns the persisted row.
 *
 * Throws on DB error; callers should catch and log. The chat route falls
 * back to "we couldn't persist this A/B run, but Side A is still streaming"
 * and continues.
 */
export async function createAbSession(input: CreateAbSessionInput): Promise<AbSessionRow> {
  return withClient(async (c) => {
    const { rows } = await c.query<RawAbSession>(
      `INSERT INTO router_ab_sessions
        (thread_id, user_message_id, assistant_message_id,
         side_a_model_id, side_a_reasoning_level,
         side_b_model_id, side_b_reasoning_level,
         task_type, confidence, short_reason,
         used_fallback, fallback_reason, skip_reason,
         cost_estimate_usd, user_prompt_text, recent_chars,
         pool_key_hash, router_model_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        input.threadId,
        input.userMessageId ?? null,
        input.assistantMessageId ?? null,
        input.sideAModelId,
        input.sideAReasoningLevel,
        input.sideBModelId ?? null,
        input.sideBReasoningLevel ?? null,
        input.taskType ?? null,
        input.confidence ?? null,
        input.shortReason ?? null,
        input.usedFallback ?? false,
        input.fallbackReason ?? null,
        input.skipReason ?? null,
        input.costEstimateUsd ?? null,
        input.userPromptText,
        input.recentChars,
        input.poolKeyHash ?? null,
        input.routerModelId,
      ],
    );
    return toAbSessionRow(rows[0]);
  });
}

export type AttachSideBInput = {
  abSessionId: string;
  assistantMessageId?: string | null;
  sideBModelId: string | null;
  sideBReasoningLevel: string | null;
  taskType: AbTaskType | null;
  confidence: number | null;
  shortReason: string | null;
  usedFallback: boolean;
  fallbackReason: string | null;
  skipReason: string | null;
  costEstimateUsd: number | null;
  sideBText?: string | null;
  sideBLatencyMs?: number | null;
};

/**
 * Patch an existing `router_ab_sessions` row with the final Side B outcome
 * (including `assistant_message_id` so the panel can be re-hydrated by
 * message on reload).
 *
 * Throws on DB error or if no row matched the id.
 */
/**
 * Append-only patch that updates only `side_b_text` and `side_b_latency_ms`.
 * Used after the Side B non-streaming call completes so the panel re-hydrates
 * the full text on page reload even though only the live SSE stream carries
 * it during the active chat.
 */
export async function recordSideBOutput(input: {
  abSessionId: string;
  sideBText: string;
  sideBLatencyMs: number;
}): Promise<void> {
  await withClient(async (c) => {
    const { rowCount } = await c.query(
      `UPDATE router_ab_sessions
       SET side_b_text       = $2,
           side_b_latency_ms = $3
       WHERE id = $1`,
      [input.abSessionId, input.sideBText, input.sideBLatencyMs],
    );
    if (rowCount === 0) {
      const error = new Error("ab_session_not_found");
      error.name = "AbSessionNotFoundError";
      throw error;
    }
  });
}

export async function attachSideBResult(input: AttachSideBInput): Promise<AbSessionRow> {
  return withClient(async (c) => {
    const { rows } = await c.query<RawAbSession>(
      `UPDATE router_ab_sessions
       SET side_b_model_id         = $2,
           side_b_reasoning_level  = $3,
           task_type               = $4,
           confidence              = $5,
           short_reason            = $6,
           used_fallback           = $7,
           fallback_reason         = $8,
           skip_reason             = $9,
           cost_estimate_usd       = $10,
           assistant_message_id    = COALESCE($11, assistant_message_id),
           side_b_text             = COALESCE($12, side_b_text),
           side_b_latency_ms       = COALESCE($13, side_b_latency_ms)
       WHERE id = $1
       RETURNING *`,
      [
        input.abSessionId,
        input.sideBModelId,
        input.sideBReasoningLevel,
        input.taskType,
        input.confidence,
        input.shortReason,
        input.usedFallback,
        input.fallbackReason,
        input.skipReason,
        input.costEstimateUsd,
        input.assistantMessageId ?? null,
        input.sideBText ?? null,
        input.sideBLatencyMs ?? null,
      ],
    );
    const r = rows[0];
    if (!r) {
      const error = new Error("ab_session_not_found");
      error.name = "AbSessionNotFoundError";
      throw error;
    }
    return toAbSessionRow(r);
  });
}

export async function getAbSession(id: string): Promise<AbSessionRow | null> {
  return withClient(async (c) => {
    const { rows } = await c.query<RawAbSession>(
      "SELECT * FROM router_ab_sessions WHERE id = $1 LIMIT 1",
      [id],
    );
    return rows[0] ? toAbSessionRow(rows[0]) : null;
  });
}

export async function getAbSessionByAssistantMessageId(
  assistantMessageId: string,
): Promise<AbSessionRow | null> {
  return withClient(async (c) => {
    const { rows } = await c.query<RawAbSession>(
      "SELECT * FROM router_ab_sessions WHERE assistant_message_id = $1 ORDER BY updated_at DESC LIMIT 1",
      [assistantMessageId],
    );
    return rows[0] ? toAbSessionRow(rows[0]) : null;
  });
}

export async function setAbFeedback(input: {
  abSessionId: string;
  rating: AbFeedbackRating;
}): Promise<AbFeedbackRow> {
  return withTransaction(async (c) => {
    const session = await c.query<{ id: string }>(
      "SELECT id FROM router_ab_sessions WHERE id = $1 LIMIT 1",
      [input.abSessionId],
    );
    if (!session.rows[0]) {
      const error = new Error("ab_session_not_found");
      error.name = "AbSessionNotFoundError";
      throw error;
    }
    const { rows } = await c.query<RawAbFeedback>(
      `INSERT INTO router_ab_feedback (ab_session_id, rating)
       VALUES ($1, $2)
       ON CONFLICT (ab_session_id) DO UPDATE
       SET rating = EXCLUDED.rating
       RETURNING ab_session_id, rating, created_at, updated_at`,
      [input.abSessionId, input.rating],
    );
    return toAbFeedbackRow(rows[0]);
  });
}

export async function getAbFeedback(abSessionId: string): Promise<AbFeedbackRow | null> {
  return withClient(async (c) => {
    const { rows } = await c.query<RawAbFeedback>(
      `SELECT ab_session_id, rating, created_at, updated_at
       FROM router_ab_feedback
       WHERE ab_session_id = $1
       LIMIT 1`,
      [abSessionId],
    );
    return rows[0] ? toAbFeedbackRow(rows[0]) : null;
  });
}
