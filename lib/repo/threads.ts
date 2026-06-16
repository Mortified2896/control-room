import "server-only";

import { tryDb, withClient } from "@/lib/db";
import type { MessageRow, MessageRole, ThreadRow } from "./types";

/**
 * Read-only repo functions for threads/messages.
 *
 * Milestone 1: these run against a not-yet-existing schema. The table names
 * are quoted so a `relation does not exist` error is surfaced as a normal
 * Postgres error and caught by `tryDb` (returning an empty list). The in-
 * memory client fallback in `app/assistant.tsx` keeps the app working.
 *
 * All functions return plain JSON-safe objects; Date columns are serialised
 * to ISO strings here so route handlers can `return Response.json(...)` them
 * directly.
 */

const THREAD_COLUMNS = "id, title, created_at, updated_at";
const MESSAGE_COLUMNS = "id, thread_id, role, parts, model_id, created_at";

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
  parts: unknown;
  model_id: string | null;
  created_at: Date;
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
    parts: r.parts,
    modelId: r.model_id,
    createdAt: r.created_at.toISOString(),
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
      `SELECT ${MESSAGE_COLUMNS} FROM messages
        WHERE thread_id = $1
        ORDER BY created_at ASC
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

// ---------------------------------------------------------------------------
// Write paths (Phase 2 / Milestone 2).
//
// Throws on any DB error -- callers (POST route handlers) should catch and
// map to a 500. We do NOT use `tryDb` here: writes have no silent fallback.
// ---------------------------------------------------------------------------

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
 * Does a thread with this id exist? Cheap existence check used by the
 * POST /api/threads/[id]/messages validation.
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

/**
 * Append a message to a thread. Caller is expected to have already verified
 * the thread exists (`threadExists`) -- this function does NOT do the
 * existence check itself, so the FK violation can be caught and reported
 * distinctly from a missing-thread 404.
 *
 * Throws on DB error.
 */
export async function createMessage(input: {
  threadId: string;
  role: MessageRole;
  content?: string | null;
  parts?: unknown;
  modelId?: string | null;
}): Promise<MessageRow> {
  return withClient(async (c) => {
    // `pg` does not auto-detect JS objects/arrays as JSON for jsonb columns,
    // so we JSON-stringify the value and add an explicit `::jsonb` cast on
    // the placeholder. null/undefined are passed through (SQL NULL).
    const partsParam = input.parts == null ? null : JSON.stringify(input.parts);
    const { rows } = await c.query<RawMessage>(
      `INSERT INTO messages (thread_id, role, content, parts, model_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id, thread_id, role, parts, model_id, created_at`,
      [input.threadId, input.role, input.content ?? null, partsParam, input.modelId ?? null],
    );
    return toMessageRow(rows[0]);
  });
}
