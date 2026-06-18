import "server-only";

import { tryDb, withClient, withTransaction } from "@/lib/db";
import { titleFromUserMessage } from "@/lib/assistant-ui/thread-messages";
import type { MessageRating, MessageRow, MessageRole, ThreadRow } from "./types";

/**
 * Repo functions for persisted chat threads/messages.
 *
 * Read paths use `tryDb` so a missing/unavailable DB can fall back gracefully.
 * Write paths throw: callers should report/handle persistence failure explicitly.
 */

const THREAD_COLUMNS = "id, title, created_at, updated_at";

type RawThread = {
  id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
};

type RawMessage = {
  id: string;
  thread_id: string;
  role: MessageRole;
  content: string | null;
  parts: unknown;
  model_id: string | null;
  created_at: Date;
  rating?: MessageRating | null;
};

function toThreadRow(r: RawThread): ThreadRow {
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function toMessageRow(r: RawMessage): MessageRow {
  return {
    id: r.id,
    threadId: r.thread_id,
    role: r.role,
    content: r.content,
    parts: r.parts,
    modelId: r.model_id,
    createdAt: r.created_at.toISOString(),
    rating: r.rating ?? null,
  };
}

/**
 * List threads, newest activity first. Returns [] if the DB is missing, the
 * table is missing, or any error occurs.
 */
export async function listThreads(): Promise<ThreadRow[]> {
  return tryDb(async (c) => {
    const { rows } = await c.query<RawThread>(
      `SELECT ${THREAD_COLUMNS} FROM threads ORDER BY updated_at DESC LIMIT 200`,
    );
    return rows.map(toThreadRow);
  }, []);
}

/**
 * Get a single thread by id. Returns null if not found or DB unavailable.
 */
export async function getThread(id: string): Promise<ThreadRow | null> {
  return tryDb(async (c) => {
    const { rows } = await c.query<RawThread>(
      `SELECT ${THREAD_COLUMNS} FROM threads WHERE id = $1 LIMIT 1`,
      [id],
    );
    const r = rows[0];
    return r ? toThreadRow(r) : null;
  }, null);
}

/**
 * List messages for a thread, oldest first. Returns [] if the DB or table is
 * missing, or any error occurs.
 */
export async function listMessages(threadId: string): Promise<MessageRow[]> {
  return tryDb(async (c) => {
    const { rows } = await c.query<RawMessage>(
      `SELECT m.id, m.thread_id, m.role, m.content, m.parts, m.model_id, m.created_at, f.rating
        FROM messages m
        LEFT JOIN message_feedback f ON f.message_id = m.id
        WHERE m.thread_id = $1
        ORDER BY m.created_at ASC
        LIMIT 1000`,
      [threadId],
    );
    return rows.map(toMessageRow);
  }, []);
}

/**
 * Smoke-test: returns true if a `SELECT 1` round-trips. Used by the health
 * endpoint and by future integration tests.
 */
export async function pingDb(): Promise<boolean> {
  if (process.env.CONTROL_ROOM_DATABASE_URL == null) return false;
  try {
    return await withClient(async (c) => {
      const { rows } = await c.query<{ ok: number }>("SELECT 1 AS ok");
      return rows[0]?.ok === 1;
    });
  } catch {
    return false;
  }
}

/**
 * Create a new thread. Returns the persisted row. `title` is required;
 * `modelId` is stored as-is and may be null.
 *
 * Throws on DB error.
 */
export async function createThread(input: {
  title: string;
  modelId?: string | null;
}): Promise<ThreadRow> {
  return withClient(async (c) => {
    const { rows } = await c.query<RawThread>(
      `INSERT INTO threads (title, model_id)
       VALUES ($1, $2)
       RETURNING id, title, created_at, updated_at`,
      [input.title, input.modelId ?? null],
    );
    return toThreadRow(rows[0]);
  });
}

/**
 * Does a thread with this id exist? Cheap existence check used by route validation.
 */
export async function threadExists(threadId: string): Promise<boolean> {
  return withClient(async (c) => {
    const { rows } = await c.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM threads WHERE id = $1) AS exists",
      [threadId],
    );
    return rows[0]?.exists === true;
  });
}

export async function renameThread(input: {
  threadId: string;
  title: string;
}): Promise<ThreadRow | null> {
  return withClient(async (c) => {
    const { rows } = await c.query<RawThread>(
      `UPDATE threads
       SET title = $2
       WHERE id = $1
       RETURNING id, title, created_at, updated_at`,
      [input.threadId, input.title.trim()],
    );
    return rows[0] ? toThreadRow(rows[0]) : null;
  });
}

/**
 * Append a message and bump thread activity in one transaction. If the message
 * is the first user message and the thread title is still exactly "New chat",
 * derive a compact sidebar title from that user message.
 */
export async function createMessage(input: {
  threadId: string;
  role: MessageRole;
  content?: string | null;
  parts?: unknown;
  modelId?: string | null;
}): Promise<MessageRow> {
  return withTransaction(async (c) => {
    const partsParam = input.parts == null ? null : JSON.stringify(input.parts);
    const { rows } = await c.query<RawMessage>(
      `INSERT INTO messages (thread_id, role, content, parts, model_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id, thread_id, role, content, parts, model_id, created_at`,
      [input.threadId, input.role, input.content ?? null, partsParam, input.modelId ?? null],
    );

    if (input.role === "user" && input.content?.trim()) {
      const title = titleFromUserMessage(input.content);
      await c.query(
        `UPDATE threads
         SET updated_at = now(),
             title = CASE WHEN title = 'New chat' THEN $2 ELSE title END
         WHERE id = $1`,
        [input.threadId, title],
      );
    } else {
      await c.query("UPDATE threads SET updated_at = now() WHERE id = $1", [input.threadId]);
    }

    return toMessageRow(rows[0]);
  });
}
