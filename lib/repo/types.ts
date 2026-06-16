/**
 * Row shapes for the v1 read-only API.
 *
 * Mirrors the proposed Postgres schema in `docs/POSTGRES_PLAN.md`. These types
 * are used by both the server (route handlers) and any future client that
 * wants to consume the data; they are intentionally minimal and JSON-safe.
 *
 * `messages.parts` is the AI SDK v6 `UIMessage.parts` shape (unknown JSON).
 */

export type ThreadRow = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type MessageRole = "user" | "assistant" | "system";

export type MessageRow = {
  id: string;
  threadId: string;
  role: MessageRole;
  parts: unknown;
  modelId: string | null;
  createdAt: string;
};
