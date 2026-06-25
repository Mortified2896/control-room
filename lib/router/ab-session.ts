/**
 * Chat-side helpers for Router A/B mode.
 *
 * Pure / I/O-light utilities used by the `/api/chat` route. The actual
 * router graph lives in `lib/router/graph.ts`; the persistence layer lives
 * in `lib/repo/router-ab.ts`. This file is the glue between them and the
 * AI SDK 6 streaming response.
 */
import type { UIMessage } from "ai";
import type { RouterRecentTurn } from "@/lib/router/prompts";
import { extractLatestUserMessage, uiMessageText } from "@/lib/assistant-ui/thread-messages";

const MAX_RECENT_TURNS = 3;
const MAX_RECENT_TURN_CHARS = 400;

/**
 * Build the recent-turns array the router prompt consumes. We strip down
 * to role + short excerpt and cap at 3 turns + 400 chars per turn so the
 * recommender prompt is bounded even on long threads.
 *
 * Deliberately does NOT include thread notes, message_feedback, or any
 * persisted metadata — the brief is explicit that the router must not
 * see those.
 */
export function buildRouterRecentTurns(messages: UIMessage[]): RouterRecentTurn[] {
  const tail = messages.slice(-1 - MAX_RECENT_TURNS, -1);
  const out: RouterRecentTurn[] = [];
  for (const m of tail) {
    if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") continue;
    const text = uiMessageText(m).slice(0, MAX_RECENT_TURNS);
    const trimmed =
      text.length > MAX_RECENT_TURN_CHARS ? `${text.slice(0, MAX_RECENT_TURN_CHARS - 1)}…` : text;
    out.push({ role: m.role, text: trimmed });
  }
  return out;
}

/**
 * Total chars in the user prompt + the recent-turn excerpts the router
 * will see. Used by the long-prompt safety guard.
 */
export function computeRouterRecentChars(
  latestUserText: string,
  recentTurns: ReadonlyArray<RouterRecentTurn>,
): number {
  let total = latestUserText.length;
  for (const t of recentTurns) total += t.text.length;
  return total;
}

/**
 * Pull the latest user text from a `UIMessage[]` array. Returns an empty
 * string when there is no user message (the router prompt builder accepts
 * that gracefully).
 */
export function latestUserText(messages: UIMessage[]): string {
  const m = extractLatestUserMessage(messages);
  return m ? uiMessageText(m) : "";
}

/**
 * SHA-256 hex digest of the router allowlist used for a given run. Cheap to
 * compute, safe to log, and lets ops de-duplicate A/B sessions that saw the
 * same allowlist. Pure.
 */
export async function poolKeyHash(
  entries: ReadonlyArray<{ modelId: string; reasoningLevel: string }>,
): Promise<string> {
  const sorted = [...entries]
    .map((e) => `${e.modelId}:${e.reasoningLevel}`)
    .sort()
    .join("|");
  const enc = new TextEncoder().encode(sorted);
  // Node-only crypto.subtle. Safe to use because this is server-side.
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
