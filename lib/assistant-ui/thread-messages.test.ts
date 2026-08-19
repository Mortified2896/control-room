import assert from "node:assert/strict";
import test from "node:test";

import {
  extractLatestUserMessage,
  messageRowsToUIMessages,
  titleFromUserMessage,
  uiMessageText,
} from "./thread-messages.ts";
import type { MessageRow } from "@/lib/repo/types";

const rows: MessageRow[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    role: "user",
    content: "hello world",
    parts: [{ type: "text", text: "hello world" }],
    modelId: null,
    createdAt: "2026-06-18T12:00:00.000Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    role: "assistant",
    content: "hi there",
    parts: [{ type: "text", text: "hi there" }],
    modelId: "gpt-test",
    createdAt: "2026-06-18T12:00:01.000Z",
    rating: "up",
  },
];

test("messageRowsToUIMessages converts only chat message fields", () => {
  const messages = messageRowsToUIMessages(rows);

  assert.deepEqual(messages, [
    {
      id: rows[0].id,
      role: "user",
      parts: [{ type: "text", text: "hello world" }],
    },
    {
      id: rows[1].id,
      role: "assistant",
      parts: [{ type: "text", text: "hi there" }],
    },
  ]);
  assert.equal("rating" in messages[1], false);
  assert.equal("notes" in messages[1], false);
  assert.equal("modelId" in messages[1], false);
});

test("messageRowsToUIMessages falls back from legacy content", () => {
  const messages = messageRowsToUIMessages([
    {
      id: "33333333-3333-4333-8333-333333333333",
      threadId: rows[0].threadId,
      role: "user",
      content: "legacy content",
      parts: null,
      modelId: null,
      createdAt: rows[0].createdAt,
    },
  ]);

  assert.deepEqual(messages[0]?.parts, [{ type: "text", text: "legacy content" }]);
});

test("uiMessageText extracts text parts only", () => {
  assert.equal(uiMessageText({ parts: [{ type: "text", text: "hello" }] }), "hello");
  assert.equal(
    uiMessageText({ parts: [{ type: "text", text: "hi" }, { type: "step-start" }] }),
    "hi",
  );
});

test("extractLatestUserMessage returns the latest user message", () => {
  const latest = extractLatestUserMessage([
    { id: "u1", role: "user", parts: [{ type: "text", text: "first" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "reply" }] },
    { id: "u2", role: "user", parts: [{ type: "text", text: "second" }] },
  ]);

  assert.equal(latest?.id, "u2");
});

test("titleFromUserMessage trims, normalizes whitespace, and caps length", () => {
  assert.equal(titleFromUserMessage("  hello\n   world  "), "hello world");
  assert.equal(titleFromUserMessage(""), "New chat");
  assert.equal(titleFromUserMessage("a".repeat(80)), `${"a".repeat(57)}…`);
});

test("messageRowsToUIMessages preserves user → R → A order so the bubble list survives reload", () => {
  // Hard contract for the reload path: DB rows re-hydrate as separate
  // UI messages in the exact order the user sees them. The assistant-ui
  // runtime then renders them as separate bubbles (after the
  // `joinStrategy: "none"` fix in app/assistant.tsx), so a hard refresh
  // shows the same user → R → A visible order as the live view.
  const user1 = "11111111-1111-4111-8111-111111111111";
  const r1 = "22222222-2222-4222-8222-222222222222";
  const a1 = "33333333-3333-4333-8333-333333333333";
  const thread = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const rows: MessageRow[] = [
    {
      id: user1,
      threadId: thread,
      role: "user",
      content: "Hi",
      parts: [{ type: "text", text: "Hi" }],
      modelId: null,
      createdAt: "2026-06-18T12:00:00.000Z",
    },
    {
      id: r1,
      threadId: thread,
      role: "assistant",
      content: "### Routing decision\n...",
      parts: [
        { type: "text", text: "### Routing decision\n..." },
        {
          type: "data-routing-decision",
          data: {
            kind: "routing_decision",
            messageType: "routing_decision",
            includeInModelContext: false,
            auditId: "audit-r1",
            route: "normal_chat",
          },
        },
      ],
      modelId: null,
      createdAt: "2026-06-18T12:00:00.500Z",
    },
    {
      id: a1,
      threadId: thread,
      role: "assistant",
      content: "Hi there! How can I help you today?",
      parts: [{ type: "text", text: "Hi there! How can I help you today?" }],
      modelId: "gpt-5.4-mini",
      createdAt: "2026-06-18T12:00:01.000Z",
    },
  ];

  const messages = messageRowsToUIMessages(rows);

  // Hydrated order: user → R → A. R and A are separate UI messages
  // (not collapsed into one), so the assistant-ui runtime can render
  // them as distinct bubbles.
  assert.equal(messages.length, 3);
  assert.equal(messages[0]?.id, user1);
  assert.equal(messages[0]?.role, "user");
  assert.equal(messages[1]?.id, r1);
  assert.equal(messages[1]?.role, "assistant");
  assert.equal(messages[2]?.id, a1);
  assert.equal(messages[2]?.role, "assistant");

  // R carries the data-routing-decision part so `isRoutingDecisionMessage`
  // can recognize it on reload (no message-level metadata available
  // after DB round-trip).
  const rParts = messages[1]?.parts ?? [];
  const hasDataPart = rParts.some(
    (p) => (p as { type?: string }).type === "data-routing-decision",
  );
  assert.equal(hasDataPart, true, "R must carry its data-routing-decision part");

  // A carries the plain text part only — the routing decision is NOT
  // merged into A on reload.
  const aParts = messages[2]?.parts ?? [];
  assert.equal(aParts.length, 1);
  assert.equal((aParts[0] as { type?: string }).type, "text");
  assert.equal(
    (aParts[0] as { text?: string }).text,
    "Hi there! How can I help you today?",
  );
});
