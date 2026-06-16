import { NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { createMessage, getThread, listMessages, threadExists } from "@/lib/repo/threads";
import type { MessageRole } from "@/lib/repo/types";

export const dynamic = "force-dynamic";

const ALLOWED_ROLES: ReadonlySet<MessageRole> = new Set<MessageRole>([
  "user",
  "assistant",
  "system",
]);

/**
 * GET /api/threads/[id]/messages
 *
 * Returns the message list for a thread (oldest first). Responds:
 *   200 { thread, messages }   -- thread found
 *   200 { thread: null, messages: [] } -- DB not configured
 *   404 { error: "thread_not_found" }  -- thread id does not exist
 *
 * Note: in Milestone 1, the messages table does not exist yet, so the
 * `messages` array will always be `[]`. That is the intended behaviour.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isDbConfigured()) {
    return NextResponse.json(
      { thread: null, messages: [], configured: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const thread = await getThread(id);
  if (!thread) {
    return NextResponse.json(
      { error: "thread_not_found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  const messages = await listMessages(id);
  return NextResponse.json(
    { thread, messages, configured: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * POST /api/threads/[id]/messages
 *
 * Body: { "role": "user" | "assistant" | "system",
 *         "content"?: string,
 *         "parts"?:   unknown,   // AI SDK v6 UIMessage.parts JSON
 *         "modelId"?: string }
 *   - `role` is required and must be one of the three allowed values.
 *   - At least one of `content` or `parts` must be present (non-empty /
 *     non-null). This keeps the table from being filled with truly empty
 *     messages while still allowing either field alone.
 *
 * Responses:
 *   201 { message }                                created
 *   400 { error: "invalid_body", reason }          bad body
 *   404 { error: "thread_not_found" }              thread id does not exist
 *   503 { error: "db_not_configured" }             env unset
 *   500 { error: "db_error", reason }              unexpected DB error
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: threadId } = await params;

  if (!isDbConfigured()) {
    return NextResponse.json(
      { error: "db_not_configured" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Validate the id is a UUID before hitting the DB -- avoids 500s on
  // malformed input.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) {
    return NextResponse.json(
      { error: "thread_not_found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_body", reason: "request body must be JSON" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (body == null || typeof body !== "object") {
    return NextResponse.json(
      { error: "invalid_body", reason: "body must be a JSON object" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const b = body as Record<string, unknown>;

  const roleRaw = b.role;
  if (typeof roleRaw !== "string" || !ALLOWED_ROLES.has(roleRaw as MessageRole)) {
    return NextResponse.json(
      { error: "invalid_body", reason: "role must be one of 'user' | 'assistant' | 'system'" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const role = roleRaw as MessageRole;

  const contentRaw = b.content;
  const partsRaw = b.parts;
  const hasContent = typeof contentRaw === "string" && contentRaw.length > 0;
  const hasParts = partsRaw != null; // any JSON value (incl. []) counts
  if (!hasContent && !hasParts) {
    return NextResponse.json(
      {
        error: "invalid_body",
        reason: "at least one of 'content' (non-empty string) or 'parts' is required",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const modelIdRaw = b.modelId;
  const modelId =
    modelIdRaw == null
      ? null
      : typeof modelIdRaw === "string" && modelIdRaw.trim().length > 0
        ? modelIdRaw
        : null;

  try {
    if (!(await threadExists(threadId))) {
      return NextResponse.json(
        { error: "thread_not_found" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    const message = await createMessage({
      threadId,
      role,
      content: hasContent ? (contentRaw as string) : null,
      parts: hasParts ? partsRaw : null,
      modelId,
    });
    return NextResponse.json(
      { message },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[api/threads/[id]/messages POST] db error:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      { error: "db_error", reason: "could not create message" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
