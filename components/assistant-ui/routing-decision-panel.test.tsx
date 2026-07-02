import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { RoutingDecisionPanel } from "./routing-decision-panel";
import type {
  RoutingDecisionPanel as RoutingDecisionPanelPayload,
} from "@/lib/router/routing-decision-panel-types";
import type { RoutingDecisionPanelModelOption } from "./routing-decision-panel";

const basePanel: RoutingDecisionPanelPayload = {
  contextDecision: {
    recommended: "chat_only",
    explanation: "Conceptual question; no project files needed.",
  },
  executionPackage: {
    model: { recommended: "codex:gpt-5.5", alternatives: ["codex:gpt-5.4-mini", "MiniMax-M3"] },
    reasoningLevel: {
      recommended: "low",
      supportedValues: ["none", "low", "medium", "high", "xhigh"],
    },
    harness: { recommended: "repo_file_harness", alternatives: ["normal_chat", "repo_file_harness"] },
    explanation: "Use the repo/file harness with low-reasoning GPT-5.5 to read AGENTS.md cheaply.",
  },
  confidence: 0.86,
  costTier: "expensive",
  latencyMs: 13_700,
};

const baseExecutionModels: ReadonlyArray<RoutingDecisionPanelModelOption> = [
  {
    modelId: "codex:gpt-5.5",
    displayLabel: "GPT-5.5 (Codex)",
    providerId: "codex",
    supportsReasoningControls: true,
    allowedReasoningLevels: ["none", "low", "medium", "high", "xhigh"],
    tier: "expensive",
  },
  {
    modelId: "codex:gpt-5.4-mini",
    displayLabel: "GPT-5.4 Mini (Codex)",
    providerId: "codex",
    supportsReasoningControls: true,
    allowedReasoningLevels: ["none", "low", "medium", "high"],
    tier: "cheap",
  },
  {
    modelId: "MiniMax-M3",
    displayLabel: "MiniMax M3",
    providerId: "minimax",
    supportsReasoningControls: true,
    allowedReasoningLevels: ["enabled", "disabled"],
    tier: "cheap",
  },
];

function renderPanel(
  panel: RoutingDecisionPanelPayload = basePanel,
  executionModels: ReadonlyArray<RoutingDecisionPanelModelOption> = baseExecutionModels,
  options: {
    onSendWithRouting?: (selection: unknown) => void;
    onSendDefault?: () => void;
    onDismiss?: () => void;
    loudFailure?: boolean;
    initialSelection?: {
      contextDecision?: "chat_only" | "harness_needed";
      modelId?: string;
      reasoningLevel?: string;
      harness?: "normal_chat" | "repo_file_harness";
      comment?: string;
    };
  } = {},
): string {
  const handlers = {
    onSendWithRouting: options.onSendWithRouting ?? (() => {}),
    onSendDefault: options.onSendDefault ?? (() => {}),
    onDismiss: options.onDismiss ?? (() => {}),
  };
  return renderToStaticMarkup(
    createElement(RoutingDecisionPanel, {
      panel,
      executionEligibleModels: executionModels,
      loudFailure: options.loudFailure ?? false,
      ...handlers,
      ...(options.initialSelection ? { initialSelection: options.initialSelection } : {}),
    }),
  );
}

test("the panel renders the new shape with confidence + cost tier + latency", () => {
  const html = renderPanel();
  assert.match(html, /Routing decision/);
  assert.match(html, /data-testid="routing-decision-confidence-badge"/);
  assert.match(html, /Confidence 86%/);
  assert.match(html, /data-testid="routing-decision-cost-tier-badge"/);
  assert.match(html, /Expensive/);
  assert.match(html, /data-testid="routing-decision-latency"/);
});

test("the panel renders context and execution-package sections with distinct explanations", () => {
  const html = renderPanel();
  assert.match(html, /data-testid="routing-decision-context-section"/);
  assert.match(html, /data-testid="routing-decision-package-section"/);
  assert.match(html, /data-testid="routing-decision-context-explanation"/);
  assert.match(html, /data-testid="routing-decision-package-explanation"/);
  // The two explanations must be distinct strings.
  const contextMatch = html.match(/data-testid="routing-decision-context-explanation"[^>]*>([^<]+)</);
  const packageMatch = html.match(/data-testid="routing-decision-package-explanation"[^>]*>([^<]+)</);
  assert.ok(contextMatch && packageMatch);
  assert.notEqual(contextMatch[1], packageMatch[1]);
});

test("the panel renders only one execution-package explanation element", () => {
  const html = renderPanel();
  const matches = html.match(/data-testid="routing-decision-package-explanation"/g) ?? [];
  assert.equal(matches.length, 1);
});

test("the panel renders 'Chat only' as the default when the recommendation is chat_only", () => {
  const html = renderPanel();
  const contextSelect = html.match(/<select[^>]*data-testid="routing-decision-context-select"[\s\S]*?<\/select>/);
  assert.ok(contextSelect);
  assert.match(contextSelect[0], /<option[^>]*value="chat_only"[^>]*>Chat only<\/option>/);
  assert.match(contextSelect[0], /<option[^>]*value="harness_needed"[^>]*>Harness needed<\/option>/);
});

test("the panel renders 'Harness needed' when the recommendation is harness_needed", () => {
  const panel: RoutingDecisionPanelPayload = {
    ...basePanel,
    contextDecision: {
      recommended: "harness_needed",
      explanation: "Asks whether a project file exists.",
    },
  };
  const html = renderPanel(panel);
  const contextSelect = html.match(/<select[^>]*data-testid="routing-decision-context-select"[\s\S]*?<\/select>/);
  assert.ok(contextSelect);
  assert.match(contextSelect[0], /<option[^>]*value="harness_needed"[^>]*>Harness needed<\/option>/);
});

test("the panel pre-selects the recommended model", () => {
  const html = renderPanel();
  const modelSelect = html.match(/<select[^>]*data-testid="routing-decision-model-select"[\s\S]*?<\/select>/);
  assert.ok(modelSelect);
  assert.match(modelSelect[0], /data-current-model="codex:gpt-5\.5"/);
});

test("the panel pre-selects the recommended reasoning level", () => {
  const html = renderPanel();
  const reasoningSelect = html.match(/<select[^>]*data-testid="routing-decision-reasoning-select"[\s\S]*?<\/select>/);
  assert.ok(reasoningSelect);
  assert.match(reasoningSelect[0], /data-current-reasoning="low"/);
});

test("the panel pre-selects the recommended harness", () => {
  const html = renderPanel();
  const harnessSelect = html.match(/<select[^>]*data-testid="routing-decision-harness-select"[\s\S]*?<\/select>/);
  assert.ok(harnessSelect);
  assert.match(harnessSelect[0], /data-current-harness="repo_file_harness"/);
  assert.match(harnessSelect[0], /<option[^>]*value="normal_chat"[^>]*>Normal chat<\/option>/);
  assert.match(harnessSelect[0], /<option[^>]*value="repo_file_harness"[^>]*>Repo\/file harness<\/option>/);
});

test("the panel disables the reasoning dropdown when the selected model does not support reasoning", () => {
  const panel: RoutingDecisionPanelPayload = {
    ...basePanel,
    executionPackage: {
      ...basePanel.executionPackage,
      model: { recommended: "no-reasoning-model", alternatives: [] },
      reasoningLevel: { recommended: "none", supportedValues: [] },
    },
  };
  const models: ReadonlyArray<RoutingDecisionPanelModelOption> = [
    {
      modelId: "no-reasoning-model",
      displayLabel: "No-Reasoning Model",
      providerId: "openai",
      supportsReasoningControls: false,
      allowedReasoningLevels: [],
      tier: "cheap",
    },
  ];
  const html = renderPanel(panel, models);
  const reasoningSelect = html.match(/<select[^>]*data-testid="routing-decision-reasoning-select"[\s\S]*?<\/select>/);
  assert.ok(reasoningSelect);
  // The dropdown must be disabled and the only option must be "none".
  assert.match(reasoningSelect[0], /disabled/);
  assert.match(reasoningSelect[0], /<option[^>]*value="none"[^>]*>none<\/option>/);
});

test("the panel renders 'Send with routing', 'Send default', and 'Dismiss' buttons", () => {
  const html = renderPanel();
  assert.match(html, /data-testid="routing-decision-send-with-routing"/);
  assert.match(html, /data-testid="routing-decision-send-default"/);
  assert.match(html, /data-testid="routing-decision-dismiss"/);
});

test("the panel renders the loud-failure notice when loudFailure=true", () => {
  const html = renderPanel(basePanel, baseExecutionModels, { loudFailure: true });
  assert.match(html, /data-testid="routing-decision-loud-failure-notice"/);
  // Model dropdown is disabled under loud failure.
  const modelSelect = html.match(/<select[^>]*data-testid="routing-decision-model-select"[\s\S]*?<\/select>/);
  assert.ok(modelSelect);
  assert.match(modelSelect[0], /disabled/);
});

test("the panel renders the comment toggle by default", () => {
  const html = renderPanel();
  assert.match(html, /data-testid="routing-decision-comment-toggle"/);
  // The actual comment input is hidden until the user opens the toggle.
  assert.doesNotMatch(html, /data-testid="routing-decision-comment-input"/);
});

test("the panel pre-populates the comment when initialSelection.comment is set", () => {
  const html = renderPanel(
    basePanel,
    baseExecutionModels,
    { initialSelection: { comment: "This is a comment" } },
  );
  // Because the comment is pre-populated, the panel opens the input.
  assert.match(html, /data-testid="routing-decision-comment-input"/);
  assert.match(html, /This is a comment/);
});

test("the panel's model dropdown never includes a ROUTER model id", () => {
  // The executionEligibleModels list is pre-filtered by the
  // parent (using getExecutionEligibleModelIds). The panel
  // renders the list verbatim; the test asserts the rendered
  // model dropdown does not contain any of the configured
  // recommender chain ids.
  const routerIds = ["codex:gpt-5.4-mini-recommender", "MiniMax-M3-recommender"];
  const filteredModels = baseExecutionModels.filter((m) => !routerIds.includes(m.modelId));
  const html = renderPanel(basePanel, filteredModels);
  for (const id of routerIds) {
    assert.doesNotMatch(html, new RegExp(`value="${id}"`));
  }
});

test("the panel does NOT render per-field verbose explanations by default", () => {
  // The brief forbids per-field verbose explanations for model /
  // reasoning / harness on the panel. The only "why" lines are
  // the context explanation + the package explanation.
  const html = renderPanel();
  assert.doesNotMatch(html, /Why this model/);
  assert.doesNotMatch(html, /Why this harness/);
  assert.doesNotMatch(html, /Why this reasoning/);
});