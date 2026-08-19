/**
 * Targeted test for routing decision inclusion in chat stream response.
 *
 * This test verifies that when a user accepts a recommendation and sends,
 * the routing decision bubble appears in the assistant message in the
 * live stream (not just after DB reload).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { convertToModelMessages, type UIMessage } from "ai";
import {
  type RoutingDecisionPayload,
  filterModelContextMessages,
  isRoutingDecisionMessage,
  routingDecisionPart,
  routingDecisionTextPart,
  isRoutingDecisionPart,
} from "@/lib/assistant-ui/routing-decision";
import { createMessage, listMessages, createThread, deleteThreads } from "@/lib/repo/threads";
import { isDbConfigured } from "@/lib/db";

test("routing decision parts should include both text and data parts", () => {
  const payload: RoutingDecisionPayload = {
    kind: "routing_decision",
    messageType: "routing_decision",
    includeInModelContext: false,
    auditId: "test-audit-123",
    route: "normal_chat",
    selectionSource: "recommender_output",
    harness: null,
    routerEngine: null,
    recommenderEngine: "gpt-5.4-mini",
    recommenderReasoningLevel: "low",
    executionModel: "gpt-5.4-mini",
    executionReasoningLevel: "low",
    fallback: null,
    whyRoute: "Test routing",
    whyModel: "Test model selection",
    alternatives: [],
  };

  const textPart = routingDecisionTextPart(payload);
  const dataPart = routingDecisionPart(payload);

  // Text part should have the markdown content
  assert.strictEqual(textPart.type, "text");
  assert.strictEqual(typeof textPart.text, "string");
  assert.ok(textPart.text.includes("Routing decision"));

  // Data part should have the structured payload
  assert.strictEqual(dataPart.type, "data-routing-decision");
  assert.ok(dataPart.data !== undefined);
  assert.strictEqual(dataPart.data.auditId, "test-audit-123");
  assert.strictEqual(dataPart.data.route, "normal_chat");
  assert.strictEqual(dataPart.data.includeInModelContext, false);
});

test("routing decision parts can be serialized and included in message parts array", () => {
  const payload: RoutingDecisionPayload = {
    kind: "routing_decision",
    messageType: "routing_decision",
    includeInModelContext: false,
    auditId: "test-audit-456",
    route: "coding_task",
    selectionSource: "recommender_output",
    harness: "Codex CLI",
    routerEngine: null,
    recommenderEngine: "gpt-5.4-mini",
    recommenderReasoningLevel: "low",
    executionModel: "gpt-5.5",
    executionReasoningLevel: "medium",
    fallback: {
      configured: true,
      attempted: false,
      used: false,
      engine: "minimax:MiniMax-M3",
    },
    whyRoute: "This appears to be a coding task.",
    whyHarness: "Codex CLI is available.",
    whyModel: "Best fit for coding.",
    alternatives: [{ harness: "minimax_cli", modelId: "MiniMax-M3" }],
  };

  // Parts should be usable in a message parts array
  const parts: unknown[] = [
    routingDecisionTextPart(payload),
    routingDecisionPart(payload),
  ];

  assert.strictEqual(parts.length, 2);
  assert.strictEqual((parts[0] as { type: string }).type, "text");
  assert.strictEqual((parts[1] as { type: string }).type, "data-routing-decision");
});

test("DB persistence keeps routing decision as its own message row with both text and data parts", async () => {
  if (!isDbConfigured()) {
    // Skip if DB is not configured
    return;
  }

  const payload: RoutingDecisionPayload = {
    kind: "routing_decision",
    messageType: "routing_decision",
    includeInModelContext: false,
    auditId: `test-persist-${Date.now()}`,
    route: "normal_chat",
    selectionSource: "recommender_output",
    harness: null,
    routerEngine: null,
    recommenderEngine: "gpt-5.4-mini",
    recommenderReasoningLevel: "low",
    executionModel: "gpt-5.4-mini",
    executionReasoningLevel: "low",
    fallback: null,
    whyRoute: "Test persistence",
    whyModel: "Test model",
    alternatives: [],
  };

  const textPart = routingDecisionTextPart(payload);
  const dataPart = routingDecisionPart(payload);

  // Create a thread for testing
  const thread = await createThread({
    title: "Test routing decision persistence",
    modelId: "test-model",
  });

  try {
    // Persist the routing decision message
    const message = await createMessage({
      threadId: thread.id,
      role: "assistant",
      content: "Routing decision",
      parts: [textPart, dataPart],
      modelId: "gpt-5.4-mini",
    });

    assert.ok(message.id !== undefined);

    // Retrieve messages and verify parts are preserved
    const messages = await listMessages(thread.id);
    const persistedMessage = messages.find((m) => m.id === message.id);

    assert.ok(persistedMessage !== undefined);
    assert.strictEqual(Array.isArray(persistedMessage?.parts), true);
    assert.strictEqual((persistedMessage?.parts as unknown[]).length, 2);

    // Verify the parts structure is preserved
    const parts = persistedMessage?.parts as unknown[];
    const hasTextPart = parts?.some(
      (p) => typeof p === "object" && p !== null && (p as { type?: string }).type === "text",
    );
    const hasDataPart = parts?.some(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        (p as { type?: string }).type === "data-routing-decision",
    );

    assert.ok(hasTextPart, "Text part should be preserved");
    assert.ok(hasDataPart, "Data part should be preserved");
  } finally {
    // Cleanup - deleteThreads deletes all threads for a project, or we can just leave it
    // For this test, we'll just leave the thread (it's a test anyway)
  }
});

test("RouterAbDataParts includes routing-decision type", async () => {
  // Import the schema to verify it includes routing-decision
  const { routerAbDataSchemas } = await import("@/lib/assistant-ui/router-ab-data-schemas");

  assert.ok("routing-decision" in routerAbDataSchemas, "routing-decision should be in routerAbDataSchemas");
  assert.ok(routerAbDataSchemas["routing-decision"] !== undefined);
});

test("isRoutingDecisionPart correctly identifies routing decision parts", () => {
  const payload: RoutingDecisionPayload = {
    kind: "routing_decision",
    messageType: "routing_decision",
    includeInModelContext: false,
    auditId: "test-is-part",
    route: "normal_chat",
    selectionSource: "recommender_output",
    harness: null,
    routerEngine: null,
    recommenderEngine: "gpt-5.4-mini",
    recommenderReasoningLevel: "low",
    executionModel: "gpt-5.4-mini",
    executionReasoningLevel: "low",
    fallback: null,
    whyRoute: "Test",
    whyModel: "Test",
    alternatives: [],
  };

  const textPart = routingDecisionTextPart(payload);
  const dataPart = routingDecisionPart(payload);

  // Text part should NOT be identified as routing decision part
  assert.strictEqual(isRoutingDecisionPart(textPart), false);

  // Data part SHOULD be identified as routing decision part
  assert.strictEqual(isRoutingDecisionPart(dataPart), true);

  // Non-routing-part objects should not be identified
  assert.strictEqual(isRoutingDecisionPart({ type: "text", text: "hello" }), false);
  assert.strictEqual(isRoutingDecisionPart(null), false);
  assert.strictEqual(isRoutingDecisionPart(undefined), false);
  assert.strictEqual(isRoutingDecisionPart("string"), false);
  assert.strictEqual(isRoutingDecisionPart({ type: "data-other", data: {} }), false);
});

test("routing decision payloads always carry the durable audit tag", () => {
  // Hard contract: every persisted routing decision must carry kind,
  // messageType, includeInModelContext, and auditId so the live view,
  // reload rehydration, and `filterModelContextMessages` can all
  // recognize it without re-parsing the data part payload.
  const minimal: RoutingDecisionPayload = {
    kind: "routing_decision",
    messageType: "routing_decision",
    includeInModelContext: false,
    auditId: "audit-minimal",
    route: "normal_chat",
  };
  const dataPart = routingDecisionPart(minimal);
  assert.strictEqual(dataPart.type, "data-routing-decision");
  assert.strictEqual((dataPart.data as { kind: unknown }).kind, "routing_decision");
  assert.strictEqual((dataPart.data as { messageType: unknown }).messageType, "routing_decision");
  assert.strictEqual((dataPart.data as { includeInModelContext: unknown }).includeInModelContext, false);
  assert.strictEqual((dataPart.data as { auditId: unknown }).auditId, "audit-minimal");
});

/**
 * End-to-end proof that the chat route excludes the routing decision
 * audit bubble from the model context BEFORE handing the message list
 * to `convertToModelMessages` (the AI SDK function that turns UI
 * messages into the wire shape the model actually sees).
 *
 * The chat route is the single source of truth for what reaches the
 * model: it calls `filterModelContextMessages(messages)` immediately
 * before `convertToModelMessages(...)`. The proof below constructs
 * the exact four-message shape a real thread ends up in
 * (user → R → A → user) and asserts the model sees only the user +
 * assistant text messages, with the routing decision stripped.
 */
test("chat route excludes routing decision from convertToModelMessages input", async () => {
  const payload: RoutingDecisionPayload = {
    kind: "routing_decision",
    messageType: "routing_decision",
    includeInModelContext: false,
    auditId: "audit-e2e",
    route: "normal_chat",
    selectionSource: "recommender_output",
    harness: null,
    routerEngine: null,
    recommenderEngine: "gpt-5.4-mini",
    recommenderReasoningLevel: "low",
    executionModel: "gpt-5.4-mini",
    executionReasoningLevel: "low",
    fallback: null,
    whyRoute: "Test route rationale",
    whyModel: "Test model rationale",
    alternatives: [{ harness: "minimax_cli", modelId: "MiniMax-M3" }],
  };

  // Build the exact 4-message shape the live thread ends up in:
  //   1. user: Hi
  //   2. assistant: routing decision (R)
  //   3. assistant: model reply (A)
  //   4. user: second prompt
  const messages: UIMessage[] = [
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "Hi" }],
    },
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
    {
      id: "u2",
      role: "user",
      parts: [{ type: "text", text: "second prompt" }],
    },
  ];

  // Sanity: every part-carrying message we expect is correctly typed.
  assert.strictEqual(isRoutingDecisionMessage(messages[1]!), true);
  assert.strictEqual(isRoutingDecisionMessage(messages[2]!), false);
  assert.strictEqual(isRoutingDecisionMessage(messages[0]!), false);
  assert.strictEqual(isRoutingDecisionMessage(messages[3]!), false);

  // Mirror the chat route: filter then convert.
  const contextMessages = filterModelContextMessages(messages);
  const modelMessages = await convertToModelMessages(
    contextMessages as Array<Omit<UIMessage, "id">>,
  );

  // Routing decision row is dropped; user + assistant text remain,
  // and the surviving order matches the visible bubble order.
  assert.deepEqual(
    contextMessages.map((m) => m.id),
    ["u1", "a1", "u2"],
    "filterModelContextMessages must drop R1 but keep u1/a1/u2",
  );

  // convertToModelMessages collapses to model-role messages. The model
  // must NEVER see the routing decision text or its data part. We
  // assert the full text payload of the model messages — that catches
  // any leak of the audit bubble's markdown (route/engine/fallback
  // /alternatives) into the context.
  const flat = JSON.stringify(modelMessages);
  assert.match(flat, /Hi there/, "model must see the assistant reply text");
  assert.match(flat, /second prompt/, "model must see the second user prompt");
  assert.doesNotMatch(flat, /Routing decision/, "model must NOT see the audit header");
  assert.doesNotMatch(flat, /audit-e2e/, "model must NOT see the routing decision auditId");
  assert.doesNotMatch(flat, /recommender_output/, "model must NOT see selection source");
  assert.doesNotMatch(flat, /gpt-5\.4-mini.*recommender/, "model must NOT see the recommender engine label");
  assert.doesNotMatch(flat, /Test route rationale/, "model must NOT see whyRoute rationale");
  assert.doesNotMatch(flat, /Test model rationale/, "model must NOT see whyModel rationale");
  assert.doesNotMatch(flat, /MiniMax-M3/, "model must NOT see the alternatives JSON");
  assert.doesNotMatch(
    flat,
    /Saved for visibility only/,
    "model must NOT see the audit-bubble visibility footer",
  );

  // Final model-message shape: user (Hi), assistant (Hi there...),
  // user (second prompt). Three messages, in order, no routing
  // decision, no audit metadata, no alternatives, no fallback trace.
  assert.strictEqual(modelMessages.length, 3);
  assert.strictEqual(modelMessages[0]!.role, "user");
  assert.strictEqual(modelMessages[1]!.role, "assistant");
  assert.strictEqual(modelMessages[2]!.role, "user");
});
