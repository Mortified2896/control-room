import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_DECISION_SYSTEM_PROMPT,
  DECISION_KEYWORD_FALLBACK,
  classifyContextDecision,
  mapContextDecisionToLegacy,
  mapLegacyToContextDecision,
  selectClassifierLane,
} from "./context-decision-classifier";
import type { ConfiguredRecommenderRung } from "./recommender-config";

function rungStub(returnValue: { decision: "chat_only" | "harness_needed"; explanation: string }) {
  return {
    source: "configured" as const,
    modelId: "codex:gpt-5.4-mini",
    providerId: "codex" as const,
    reasoningLevel: "low",
  } satisfies ConfiguredRecommenderRung;
}

test("CONTEXT_DECISION_SYSTEM_PROMPT mentions the new enum values and examples", () => {
  assert.match(CONTEXT_DECISION_SYSTEM_PROMPT, /chat_only/);
  assert.match(CONTEXT_DECISION_SYSTEM_PROMPT, /harness_needed/);
  assert.match(CONTEXT_DECISION_SYSTEM_PROMPT, /Do we have an AGENTS\.md/);
  assert.match(CONTEXT_DECISION_SYSTEM_PROMPT, /What is TypeScript/);
});

test("CONTEXT_DECISION_SYSTEM_PROMPT does NOT bias toward 'coding task' framing", () => {
  // The new enum is about repo/file access, not coding. The
  // prompt must not prime the classifier with a coding-task
  // heuristic. We pin this so a future refactor that adds
  // "Use coding_task for code-related prompts" regresses this
  // test.
  assert.doesNotMatch(CONTEXT_DECISION_SYSTEM_PROMPT, /coding task/i);
  assert.doesNotMatch(CONTEXT_DECISION_SYSTEM_PROMPT, /code-related/i);
});

test("DECISION_KEYWORD_FALLBACK maps the brief's harness examples to harness_needed", () => {
  const harnessPrompts = [
    "Do we have an AGENTS.md?",
    "What is inside AGENTS.md?",
    "Where is the router implemented?",
    "Which env vars does this project need?",
    "Why is the build failing?",
    "Can you change the settings page?",
  ];
  for (const prompt of harnessPrompts) {
    const out = DECISION_KEYWORD_FALLBACK(prompt);
    assert.equal(
      out.decision,
      "harness_needed",
      `expected harness_needed for: ${prompt}`,
    );
    assert.ok(out.explanation.length > 0, `expected explanation for: ${prompt}`);
    assert.ok(out.explanation.length <= 200, `explanation too long for: ${prompt}`);
  }
});

test("DECISION_KEYWORD_FALLBACK maps the brief's chat-only examples to chat_only", () => {
  const chatPrompts = [
    "What is TypeScript?",
    "Explain what AGENTS.md usually is",
    "What does routing mean in general?",
    "Help me think through this idea without checking files",
  ];
  for (const prompt of chatPrompts) {
    const out = DECISION_KEYWORD_FALLBACK(prompt);
    assert.equal(out.decision, "chat_only", `expected chat_only for: ${prompt}`);
    assert.ok(out.explanation.length > 0);
  }
});

test("DECISION_KEYWORD_FALLBACK distinguishes 'Explain what AGENTS.md usually is' from 'What is inside AGENTS.md?'", () => {
  // The brief calls this out as the canary: the "usually is"
  // framing is general knowledge, not repo inspection. Both
  // messages mention AGENTS.md but only the second one is a
  // repo inspection request.
  const general = DECISION_KEYWORD_FALLBACK("Explain what AGENTS.md usually is");
  assert.equal(general.decision, "chat_only");
  const inspect = DECISION_KEYWORD_FALLBACK("What is inside AGENTS.md?");
  assert.equal(inspect.decision, "harness_needed");
});

test("selectClassifierLane returns 'deterministic' when the chain is empty", () => {
  assert.equal(selectClassifierLane({ message: "Hi", chainLength: 0 }), "deterministic");
});

test("selectClassifierLane returns 'deterministic' for very short messages", () => {
  assert.equal(selectClassifierLane({ message: "Hi", chainLength: 2 }), "deterministic");
  assert.equal(
    selectClassifierLane({
      message: "What is the difference between normal chat and a coding task in routing?",
      chainLength: 2,
    }),
    "llm",
  );
});

test("selectClassifierLane returns 'deterministic' for very long messages", () => {
  const long = "x".repeat(4500);
  assert.equal(selectClassifierLane({ message: long, chainLength: 2 }), "deterministic");
});

test("selectClassifierLane returns 'llm' for normal-length messages when the chain is configured", () => {
  assert.equal(
    selectClassifierLane({
      message: "What is the diff between the two routing strategies?",
      chainLength: 2,
    }),
    "llm",
  );
});

test("classifyContextDecision returns the first successful rung's output and records it", async () => {
  const chain: ReadonlyArray<ConfiguredRecommenderRung> = [
    { source: "configured", modelId: "codex:gpt-5.4-mini", providerId: "codex", reasoningLevel: "low" },
  ];
  const result = await classifyContextDecision({
    message: "Do we have an AGENTS.md?",
    chain,
    runRung: async () => ({
      decision: "harness_needed",
      explanation: "Asks about a project file.",
    }),
  });
  assert.equal(result.value.decision, "harness_needed");
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0]?.succeeded, true);
  assert.equal(result.source, "llm");
});

test("classifyContextDecision falls through to the configured fallback when the primary fails", async () => {
  const chain: ReadonlyArray<ConfiguredRecommenderRung> = [
    { source: "configured", modelId: "codex:gpt-5.4-mini", providerId: "codex", reasoningLevel: "low" },
    {
      source: "configured_fallback",
      modelId: "minimax:MiniMax-M3",
      providerId: "minimax",
      reasoningLevel: undefined,
    },
  ];
  let callIndex = 0;
  const result = await classifyContextDecision({
    message: "What is TypeScript?",
    chain,
    runRung: async () => {
      callIndex += 1;
      if (callIndex === 1) throw new Error("primary_failed");
      return { decision: "chat_only", explanation: "Conceptual question." };
    },
  });
  assert.equal(result.value.decision, "chat_only");
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0]?.succeeded, false);
  assert.equal(result.attempts[1]?.succeeded, true);
  assert.equal(result.source, "llm");
});

test("classifyContextDecision falls back to the keyword classifier when every rung fails", async () => {
  const chain: ReadonlyArray<ConfiguredRecommenderRung> = [
    { source: "configured", modelId: "codex:gpt-5.4-mini", providerId: "codex", reasoningLevel: "low" },
  ];
  const result = await classifyContextDecision({
    message: "Do we have an AGENTS.md?",
    chain,
    runRung: async () => {
      throw new Error("provider down");
    },
  });
  // The deterministic fallback looks at the message and returns
  // harness_needed because the message mentions a project file.
  assert.equal(result.value.decision, "harness_needed");
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0]?.succeeded, false);
  assert.equal(result.source, "deterministic");
});

test("classifyContextDecision rejects invalid outputs and continues to the next rung", async () => {
  const chain: ReadonlyArray<ConfiguredRecommenderRung> = [
    { source: "configured", modelId: "codex:gpt-5.4-mini", providerId: "codex", reasoningLevel: "low" },
    {
      source: "configured_fallback",
      modelId: "minimax:MiniMax-M3",
      providerId: "minimax",
      reasoningLevel: undefined,
    },
  ];
  let callIndex = 0;
  const result = await classifyContextDecision({
    message: "What is TypeScript?",
    chain,
    runRung: async () => {
      callIndex += 1;
      if (callIndex === 1) return { decision: "coding_task" as never, explanation: "wrong enum" };
      return { decision: "chat_only", explanation: "Conceptual question." };
    },
  });
  assert.equal(result.value.decision, "chat_only");
  assert.equal(result.attempts[0]?.succeeded, false);
  assert.equal(result.attempts[0]?.reason, "invalid_classifier_output");
  assert.equal(result.attempts[1]?.succeeded, true);
});

test("mapContextDecisionToLegacy maps chat_only to normal_chat and harness_needed to coding_task", () => {
  assert.equal(mapContextDecisionToLegacy("chat_only"), "normal_chat");
  assert.equal(mapContextDecisionToLegacy("harness_needed"), "coding_task");
});

test("mapLegacyToContextDecision round-trips with mapContextDecisionToLegacy", () => {
  for (const d of ["chat_only", "harness_needed"] as const) {
    assert.equal(mapLegacyToContextDecision(mapContextDecisionToLegacy(d)), d);
  }
  for (const d of ["normal_chat", "coding_task"] as const) {
    assert.equal(mapContextDecisionToLegacy(mapLegacyToContextDecision(d)), d);
  }
});

// Reference the stub so the helper signature is observable in
// the test output (and a future refactor that changes the
// signature is forced to update this file).
test("rungStub matches the ConfiguredRecommenderRung shape", () => {
  const r = rungStub({ decision: "chat_only", explanation: "x" });
  assert.equal(r.source, "configured");
  assert.equal(r.modelId, "codex:gpt-5.4-mini");
  assert.equal(r.providerId, "codex");
});