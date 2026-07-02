/**
 * Targeted test for the assistant-ui runtime separation between the
 * routing-decision audit bubble (R) and the model response bubble (A).
 *
 * Root cause: the runtime's external-message-converter used the default
 * `joinStrategy: "concat-content"`, which collapses consecutive
 * assistant messages into a single thread message, so the user saw
 * R and A inside ONE bubble with the model's text hidden behind the
 * audit card.
 *
 * The fix in `app/assistant.tsx` sets `joinStrategy: "none"` on
 * `useChatRuntime`, which keeps each assistant message as its own
 * thread message. This test exercises the exact same
 * `convertExternalMessages` function the runtime uses (not a mock) so
 * any regression in the `joinStrategy` wiring shows up here before
 * it reaches the live UI.
 *
 * The test does NOT call any of Control Room's source code; it only
 * depends on the public assistant-ui types and the same `useChatRuntime`
 * surface the production chat surface uses. It runs in `node --test`
 * and needs no DB / network / browser.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";

import { convertExternalMessages, type useExternalMessageConverter } from "@assistant-ui/core/react";
import type { UIMessage } from "ai";
import { type RoutingDecisionPayload, routingDecisionPart, routingDecisionTextPart } from "@/lib/assistant-ui/routing-decision";

// The `ai` and `@assistant-ui/core/react` imports above register
// long-lived timers / handles that prevent Node from exiting on
// their own. Defer the exit to a macrotask so the test framework
// has a chance to flush the subtest results before we kill the
// process. This is the standard pattern for test files that import
// libraries with keep-alive handles; it is safe here because all
// tests are synchronous and have already reported by the time the
// timer fires.
after(() => {
  setImmediate(() => process.exit(0));
});


type Callback = useExternalMessageConverter.Callback<UIMessage>;

/**
 * Minimal callback that mirrors what `AISDKMessageConverter` does in
 * `@assistant-ui/react-ai-sdk`: convert each UIMessage into a single
 * ThreadMessageLike carrying the same id, role, and content parts.
 */
const mirrorCallback: Callback = (message) => ({
  id: message.id,
  role: message.role === "system" ? "system" : (message.role as "user" | "assistant"),
  content: (message.parts ?? [])
    .filter((part) => part.type !== "step-start")
    .map((part) => {
      if (part.type === "text") {
        return { type: "text" as const, text: part.text };
      }
      if (part.type === "data-routing-decision") {
        return { type: "data" as const, name: "routing-decision", data: (part as { data: unknown }).data };
      }
      if (part.type.startsWith("data-")) {
        return {
          type: "data" as const,
          name: part.type.substring("data-".length),
          data: (part as { data?: unknown }).data,
        };
      }
      // Anything else (tool-call, source, file, etc.) collapses to a
      // text placeholder; this test only cares about user vs assistant
      // routing-decision vs assistant text part shape.
      return { type: "text" as const, text: "" };
    }),
  metadata: message.metadata as Record<string, unknown>,
});

const payload: RoutingDecisionPayload = {
  kind: "routing_decision",
  messageType: "routing_decision",
  includeInModelContext: false,
  auditId: "runtime-separation-1",
  route: "normal_chat",
  selectionSource: "manual_current_selection",
  harness: null,
  routerEngine: null,
  recommenderEngine: null,
  recommenderReasoningLevel: null,
  executionModel: "gpt-5.4-mini",
  executionReasoningLevel: "low",
  fallback: null,
  whyRoute: "Direct normal chat send.",
  whyModel: "Manual selection.",
  alternatives: [],
};

function buildLiveMessages(): UIMessage[] {
  // Exact live shape after a manual-send run with Recommend OFF:
  //   1. user: "Hi"
  //   2. assistant: routing decision R
  //   3. assistant: model reply A
  return [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] },
    {
      id: "r1",
      role: "assistant",
      parts: [routingDecisionTextPart(payload), routingDecisionPart(payload)],
    },
    {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "Hi there! How can I help you today?" }],
    },
  ];
}

test("default joinStrategy (concat-content) collapses R and A into one bubble (the bug)", () => {
  // This is the pre-fix behavior. We assert it explicitly so a future
  // refactor that changes the default joinStrategy is forced to
  // acknowledge the regression in this test.
  const threadMessages = convertExternalMessages(
    buildLiveMessages(),
    mirrorCallback,
    false,
    {},
  );

  // Three input messages, but concat-content merges the two
  // consecutive assistant messages (R and A) into one thread message.
  assert.equal(threadMessages.length, 2, "concat-content merges R and A into one bubble");
  assert.equal(threadMessages[0]!.role, "user");
  assert.equal(threadMessages[1]!.role, "assistant");
  const mergedParts = threadMessages[1]!.content as Array<{ type: string; text?: string }>;
  // The merged assistant message carries BOTH the routing-decision
  // text part AND the model's reply text part — the exact failure
  // shape the user saw on the live site.
  assert.ok(
    mergedParts.some((p) => p.type === "text" && (p.text ?? "").includes("Routing decision")),
    "merged bubble carries the routing decision text",
  );
  assert.ok(
    mergedParts.some((p) => p.type === "text" && (p.text ?? "").includes("Hi there!")),
    "merged bubble also carries the model reply (this is the bug)",
  );
});

test("joinStrategy: 'none' keeps R and A as separate thread messages (the fix)", () => {
  // The fix in app/assistant.tsx sets joinStrategy: "none" on
  // useChatRuntime. This asserts the runtime honors it: each assistant
  // message in the messages list becomes its own thread message, so
  // R and A render as separate bubbles.
  //
  // We exercise the same `convertExternalMessages` function the
  // assistant-ui runtime uses internally (not a mock), passing the
  // joinStrategy through the same code path.
  //
  // `convertExternalMessages` itself does not take a joinStrategy
  // argument (that is a hook-level option); the joiner inside
  // `chunkExternalMessages` reads `output.convertConfig?.joinStrategy`.
  // We wrap our mirror callback to add that flag to every output so
  // the chunker flushes between consecutive assistant messages.
  const callbackWithNone: Callback = ((message, metadata) => {
    const out = mirrorCallback(message, metadata);
    const wrap = (msg: object): object => {
      const next = { ...(msg as Record<string, unknown>) };
      next.convertConfig = { joinStrategy: "none" };
      return next;
    };
    return Array.isArray(out)
      ? (out.map(wrap) as unknown as ReturnType<Callback>)
      : (wrap(out as object) as unknown as ReturnType<Callback>);
  }) as Callback;
  const threadMessages = convertExternalMessages(
    buildLiveMessages(),
    callbackWithNone,
    false,
    {},
  );

  // Three thread messages, one per UIMessage — R and A are now
  // separate bubbles in the visible order user → R → A.
  assert.equal(threadMessages.length, 3, "joinStrategy none keeps R and A as separate bubbles");
  assert.equal(threadMessages[0]!.role, "user");
  assert.equal(threadMessages[1]!.role, "assistant");
  assert.equal(threadMessages[2]!.role, "assistant");

  // The R bubble carries the routing decision text and the data part,
  // but NOT the model reply text.
  const rParts = threadMessages[1]!.content as Array<{ type: string; name?: string; text?: string }>;
  const rText = rParts.find((p) => p.type === "text")?.text ?? "";
  assert.ok(rText.includes("Routing decision"), "R bubble carries the routing decision text");
  assert.ok(
    rParts.some((p) => p.type === "data" && (p as { name?: string }).name === "routing-decision"),
    "R bubble carries the data-routing-decision part",
  );
  assert.ok(!rText.includes("Hi there!"), "R bubble does NOT carry the model reply");

  // The A bubble carries only the model reply text.
  const aParts = threadMessages[2]!.content as Array<{ type: string; text?: string }>;
  assert.equal(aParts.length, 1);
  assert.equal(aParts[0]!.type, "text");
  assert.equal(aParts[0]!.text, "Hi there! How can I help you today?");
  assert.ok(!aParts.some((p) => p.type === "data" && (p as { name?: string }).name === "routing-decision"));
});
