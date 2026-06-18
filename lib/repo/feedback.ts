import "server-only";

import { withClient, withTransaction } from "@/lib/db";
import { normalizeThreadNoteBody } from "./feedback-helpers";
import type { MessageRating, ThreadNoteRow } from "./types";
type RawThreadNote = {
  thread_id: string;
  body: string;
  created_at: Date;
  updated_at: Date;
};

function toThreadNoteRow(row: RawThreadNote): ThreadNoteRow {
  return {
    threadId: row.thread_id,
    body: row.body,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function getMessageRating(messageId: string): Promise<MessageRating | null> {
  return withClient(async (c) => {
    const { rows } = await c.query<{ rating: MessageRating }>(
      "SELECT rating FROM message_feedback WHERE message_id = $1 LIMIT 1",
      [messageId],
    );
    return rows[0]?.rating ?? null;
  });
}

export async function setOrToggleMessageRating(input: {
  messageId: string;
  rating: MessageRating;
}): Promise<MessageRating | null> {
  return withTransaction(async (c) => {
    const existing = await c.query<{ rating: MessageRating; role: string }>(
      `SELECT f.rating, m.role
       FROM messages m
       LEFT JOIN message_feedback f ON f.message_id = m.id
       WHERE m.id = $1
       LIMIT 1`,
      [input.messageId],
    );
    const row = existing.rows[0];
    if (!row) {
      const error = new Error("message_not_found");
      error.name = "MessageNotFoundError";
      throw error;
    }
    if (row.role !== "assistant") {
      const error = new Error("feedback_only_allowed_for_assistant_messages");
      error.name = "InvalidFeedbackTargetError";
      throw error;
    }
    if (row.rating === input.rating) {
      await c.query("DELETE FROM message_feedback WHERE message_id = $1", [input.messageId]);
      return null;
    }
    const { rows } = await c.query<{ rating: MessageRating }>(
      `INSERT INTO message_feedback (message_id, rating)
       VALUES ($1, $2)
       ON CONFLICT (message_id) DO UPDATE
       SET rating = EXCLUDED.rating
       RETURNING rating`,
      [input.messageId, input.rating],
    );
    return rows[0]?.rating ?? null;
  });
}

export async function getThreadNote(threadId: string): Promise<ThreadNoteRow | null> {
  return withClient(async (c) => {
    const { rows } = await c.query<RawThreadNote>(
      `SELECT thread_id, body, created_at, updated_at
       FROM thread_notes
       WHERE thread_id = $1
       LIMIT 1`,
      [threadId],
    );
    return rows[0] ? toThreadNoteRow(rows[0]) : null;
  });
}

export async function upsertThreadNote(input: {
  threadId: string;
  body: string;
}): Promise<ThreadNoteRow> {
  const body = normalizeThreadNoteBody(input.body);
  return withClient(async (c) => {
    const { rows } = await c.query<RawThreadNote>(
      `INSERT INTO thread_notes (thread_id, body)
       VALUES ($1, $2)
       ON CONFLICT (thread_id) DO UPDATE
       SET body = EXCLUDED.body
       RETURNING thread_id, body, created_at, updated_at`,
      [input.threadId, body],
    );
    return toThreadNoteRow(rows[0]);
  });
}
