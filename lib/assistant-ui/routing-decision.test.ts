import test from "node:test";
import assert from "node:assert/strict";
import {
  filterModelContextMessages,
  formatRoutingDecisionMarkdown,
  isRoutingDecisionMessage,
  routingDecisionPart,
  type RoutingDecisionPayload,
} from "./routing-decision";

const payload: RoutingDecisionPayload = {
  messageType: "routing_decision",
  includeInModelContext: false,
  auditId: "audit-1",
  route: "coding_task",
  selectionSource: "recommender_output",
  harness: "Codex CLI",
  recommenderEngine: "codex:gpt-5.5",
  recommenderReasoningLevel: "low",
  executionModel: "gpt-5.4-mini",
  executionReasoningLevel: "low",
  fallback: { configured: true, attempted: false, used: false, engine: "minimax:MiniMax-M3" },
  whyRoute: "Requires repository edits.",
  whyHarness: "Codex CLI is available.",
  whyModel: "Best fit for coding.",
  alternatives: [{ harness: "minimax_cli", modelId: "MiniMax-M3" }],
};

test("routing decision messages are marked and excluded from model context", () => {
  const routing = { id: "r", role: "assistant" as const, parts: [routingDecisionPart(payload)] };
  const user = { id: "u", role: "user" as const, parts: [{ type: "text" as const, text: "do work" }] };

  assert.equal(isRoutingDecisionMessage(routing), true);
  assert.deepEqual(filterModelContextMessages([routing, user]), [user]);
});

test("routing decision markdown documents audit-only behavior", () => {
  const text = formatRoutingDecisionMarkdown(payload);
  assert.match(text, /Routing decision/);
  assert.match(text, /Not sent to the execution model/);
  assert.match(text, /Selection source: recommender_output/);
  assert.match(text, /Codex CLI/);
  assert.match(text, /gpt-5\.4-mini/);
  assert.match(text, /Alternatives returned/);
});

test("manual direct normal-chat routing decision records current selection and stays out of context", () => {
  const manual: RoutingDecisionPayload = {
    messageType: "routing_decision",
    includeInModelContext: false,
    auditId: "manual-1",
    route: "normal_chat",
    selectionSource: "manual_current_selection",
    harness: null,
    recommenderEngine: null,
    recommenderReasoningLevel: null,
    executionModel: "MiniMax-M2.7-highspeed",
    executionReasoningLevel: "provider_default",
    fallback: null,
    whyRoute: "Direct normal chat send using the current manual selection.",
    whyModel: "Recommender was not used.",
  };
  const routing = { id: "r", role: "assistant" as const, parts: [routingDecisionPart(manual)] };
  const user = { id: "u", role: "user" as const, parts: [{ type: "text" as const, text: "hi" }] };
  const text = formatRoutingDecisionMarkdown(manual);

  assert.deepEqual(filterModelContextMessages([user, routing]), [user]);
  assert.match(text, /Route: normal chat/);
  assert.match(text, /Selection source: manual_current_selection/);
  assert.match(text, /Harness: none/);
  assert.match(text, /Router\/recommender engine: not used/);
  assert.match(text, /Execution model: MiniMax-M2\.7-highspeed/);
  assert.match(text, /Execution reasoning level: provider_default/);
});
