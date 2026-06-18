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
