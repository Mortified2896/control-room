/**
 * Pure / behavioral tests for the loud-failure proposal pipeline
 * that the model/recommend route uses after every rung of the
 * configured recommender chain has failed. The aim of this file
 * is to pin the
 *
 *   "primary configured recommender → paired configured fallback
 *    recommender → blocked; no third hidden Codex / MiniMax /
 *    OpenAI rung is appended"
 *
 * contract under the brief. The route's catch block derives its
 * `proposedSubscriptionFallbacks` candidates from the LIVE
 * availableModels registry, so a third `codex:gpt-5.4-mini` is
 * never hardcoded into the response: it appears only when the
 * registry reports it as enabled.
 *
 * We exercise that contract by constructing the same data shape
 * the route builds at runtime and asserting the resulting
 * proposal pipeline (`enforceNoApiBillingFallback`) returns
 * subscription-backed candidates that match the registry exactly.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { enforceNoApiBillingFallback, proposeSubscriptionFallbacks } from "@/lib/policy/no-api-billing-fallback";

import type { ModelMeta } from "@/lib/providers/types";

function metaFor(modelId: string, providerId: "minimax" | "codex" | "openai"): ModelMeta {
  return {
    providerId,
    modelId,
    modelLabel: modelId,
    tier: "cheap",
    reasoningCapability: { kind: "thinking_budget", control: "supported" } as ModelMeta["reasoningCapability"],
    reasoningLevels: ["provider_default"],
    billingSource: providerId === "openai" ? "api_billing" : "subscription",
  };
}

test("proposal pipeline: subscription candidates come from the live registry, not a hardcoded list", () => {
  // Build the same candidate list the route builds from
  // availableModels when a subscription proposal is requested.
  // The list contains ONLY what the live registry reports as
  // enabled — NO `codex:gpt-5.4-mini` default is appended.
  const liveCandidates: ReadonlyArray<ModelMeta> = [
    metaFor("MiniMax-M3", "minimax"),
    metaFor("MiniMax-M2", "minimax"),
  ];
  const registry = liveCandidates.map((c) => ({ modelId: c.modelId, displayLabel: c.modelLabel }));

  const proposals = enforceNoApiBillingFallback({
    requested: {
      modelId: "codex:gpt-5.5",
      providerId: "codex",
      billingSource: "subscription",
      selectionSource: "user_accepted",
    },
    kind: "recommender_runner_failed",
    reason: "primary + fallback recommender failed",
    candidates: liveCandidates,
    registry,
  }).proposals;

  // Only MiniMax ids appear (the configured fallback). No hidden
  // Codex GPT-5.4 Mini rung shows up because the registry didn't
  // list it.
  const proposalModelIds = proposals.map((p) => p.toModelId).sort();
  assert.deepEqual(proposalModelIds, ["MiniMax-M2", "MiniMax-M3"].sort());
  for (const p of proposals) {
    assert.equal(p.billingSource, "subscription");
  }
  assert.ok(!proposals.some((p) => p.toModelId.includes("gpt-5.4-mini")));
  assert.ok(!proposals.some((p) => p.toModelId.includes("gpt-5.5")));
});

test("proposal pipeline: GPT-5.4 Mini is included only when explicitly in the live registry", () => {
  // The brief: GPT-5.4 Mini may still be an available execution
  // candidate (or even a user-configured fallback), but it must
  // not be *automatically* appended. We simulate that the live
  // registry DOES include Codex models (because central discovery
  // says it does), and we verify the resulting proposals mirror
  // the registry verbatim — no extra `codex:gpt-5.4-mini` outside
  // the registry is forced.
  const liveCandidates: ReadonlyArray<ModelMeta> = [
    metaFor("MiniMax-M3", "minimax"),
    metaFor("codex:gpt-5.5", "codex"),
    metaFor("codex:gpt-5.4", "codex"),
  ];
  const registry = liveCandidates.map((c) => ({ modelId: c.modelId, displayLabel: c.modelLabel }));

  const proposals = enforceNoApiBillingFallback({
    requested: {
      modelId: "codex:gpt-5.5",
      providerId: "codex",
      billingSource: "subscription",
      selectionSource: "user_accepted",
    },
    kind: "recommender_runner_failed",
    reason: "primary + fallback recommender failed",
    candidates: liveCandidates,
    registry,
  }).proposals;

  // The proposals reflect the live registry. Note that the
  // REQUESTED model id (`codex:gpt-5.5`) is filtered out by
  // `proposeSubscriptionFallbacks`.
  const proposalModelIds = proposals.map((p) => p.toModelId).sort();
  assert.ok(proposalModelIds.includes("MiniMax-M3"));
  assert.ok(proposalModelIds.includes("codex:gpt-5.4"));
  assert.equal(
    proposalModelIds.includes("codex:gpt-5.5"),
    false,
    "the requested model id must be excluded from its own proposals",
  );
  // The brief explicitly allows GPT-5.4 Mini to remain an
  // available candidate when central discovery says it is; this
  // registry DOES NOT include it, so it must NOT appear here.
  assert.equal(
    proposalModelIds.includes("codex:gpt-5.4-mini"),
    false,
    "GPT-5.4 Mini must not be auto-appended as a hidden fallback",
  );
});

test("proposal pipeline: when only MiniMax-M3 is configured, no Codex default is forced", () => {
  // Regression test for the brief. With only MiniMax-M3 in the
  // registry, the catch-block proposal pipeline must surface
  // exactly MiniMax-M3 (the configured fallback) and nothing
  // else.
  const liveCandidates: ReadonlyArray<ModelMeta> = [metaFor("MiniMax-M3", "minimax")];
  const registry = liveCandidates.map((c) => ({ modelId: c.modelId, displayLabel: c.modelLabel }));

  const proposals = enforceNoApiBillingFallback({
    requested: {
      modelId: "MiniMax-M3",
      providerId: "minimax",
      billingSource: "subscription",
      selectionSource: "user_accepted",
    },
    kind: "recommender_runner_failed",
    reason: "primary + fallback recommender failed",
    candidates: liveCandidates,
    registry,
  }).proposals;

  // The requested model id is filtered out. With only one
  // model in the registry, no proposals remain — that is the
  // correct "blocked loudly" outcome.
  assert.deepEqual(proposals.map((p) => p.toModelId), []);
});

test("proposeSubscriptionFallbacks filters API-billed candidates and the requested model id", () => {
  // API-billed (OpenAI) candidates are NEVER surfaced as
  // subscription proposals under the no-API-billing-fallback
  // policy. This is the single chokepoint that enforces that
  // rule.
  const liveCandidates: ReadonlyArray<ModelMeta> = [
    metaFor("gpt-5.4-mini", "openai"),
    metaFor("gpt-5.5", "openai"),
    metaFor("MiniMax-M3", "minimax"),
    metaFor("codex:gpt-5.5", "codex"),
  ];
  const registry = liveCandidates.map((c) => ({ modelId: c.modelId, displayLabel: c.modelLabel }));

  const proposals = proposeSubscriptionFallbacks({
    requestedModelId: "MiniMax-M3",
    requestedProviderId: "minimax",
    candidates: liveCandidates,
    registry,
    reason: "MiniMax quota exhausted",
  });

  // MiniMax-M3 (the requested model id) is excluded. OpenAI API
  // models are excluded by the no-API-billing policy. Only
  // subscription-backed candidates remain.
  const ids = proposals.map((p) => p.toModelId).sort();
  assert.deepEqual(ids, ["codex:gpt-5.5"]);
  // Belt-and-braces: no API-billed proposal slipped through.
  for (const p of proposals) {
    assert.equal(p.billingSource, "subscription");
    assert.notEqual(p.toProviderId, "openai");
  }
});
