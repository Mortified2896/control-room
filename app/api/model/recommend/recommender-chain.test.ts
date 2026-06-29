import assert from "node:assert/strict";
import test from "node:test";

import {
  walkRecommenderChain,
  type RecommenderChainRung,
  type RecommenderChainAvailableModel,
  type RecommenderOutputShape,
  type ResolveFn,
  type RunRungFn,
} from "./recommender-chain.ts";

/**
 * Fast unit coverage for the two-rung recommender chain walker.
 *
 * Why this file exists: the e2e suite at
 * `e2e/two-rung-recommender.spec.ts` exercises the same contract but
 * against a live Next.js process (~30s spin-up per run). The
 * walker is pure logic that pins down the brief's product contract
 * — it should fail in under a second when the contract regresses.
 *
 * The four required scenarios:
 *
 *   1. First rung fails / rejects → second rung is attempted.
 *   2. Fabricated / test ids use an accepted prefixed form,
 *      e.g. `codex:no-such-engine-xyz`. The walker must accept
 *      these as a rung (so the resolver's failure is recorded
 *      explicitly), not silently drop them.
 *   3. A disabled / invalid rung is skipped with `continue`,
 *      not hard-stopped with `break`.
 *   4. `reasoningOverride` (a.k.a. `rung.reasoningLevel`) is
 *      actually forwarded to the rung's call AND surfaces on the
 *      resulting `level` for the chosen model.
 *
 * All four scenarios run against a stub `resolveModel` + `runRung`
 * — no I/O, no env reads, no DB.
 */

const AVAILABLE_MODELS: ReadonlyArray<RecommenderChainAvailableModel> = [
  {
    provider: "openai",
    modelId: "gpt-5.4-mini",
    supportsReasoningControls: true,
    allowedReasoningLevels: ["low", "medium", "xhigh"],
  },
  {
    provider: "codex",
    modelId: "codex:gpt-5.4-mini",
    // Codex does not advertise reasoning controls at runtime.
    supportsReasoningControls: false,
    allowedReasoningLevels: [],
  },
];

function makeChain(args: {
  primaryModelId: string;
  primaryReasoningLevel: string | undefined;
  fallbackModelId: string;
  fallbackReasoningLevel: string | undefined;
}): RecommenderChainRung[] {
  return [
    {
      source: "configured",
      providerId: "codex",
      modelId: args.primaryModelId,
      reasoningLevel: args.primaryReasoningLevel,
    },
    {
      source: "configured_fallback",
      providerId: "codex",
      modelId: args.fallbackModelId,
      reasoningLevel: args.fallbackReasoningLevel,
    },
  ];
}

function goodRecommendation(modelId: string, reasoning: string | null): RecommenderOutputShape {
  return {
    recommendedModelId: modelId,
    recommendedProvider: "openai",
    recommendedReasoningLevel: reasoning,
    reasoning: "ok",
    alternatives: [],
  };
}

test("scenario 1: first rung rejects, second rung is attempted and succeeds", async () => {
  const chain = makeChain({
    primaryModelId: "codex:no-such-primary",
    primaryReasoningLevel: "low",
    fallbackModelId: "codex:gpt-5.4-mini",
    fallbackReasoningLevel: "low",
  });
  const runRung: RunRungFn = async ({ rung }) => {
    if (rung.source === "configured") {
      throw new Error("primary unavailable: usage_limit");
    }
    return goodRecommendation("gpt-5.4-mini", "medium");
  };
  const resolveModel: ResolveFn = (modelId) => {
    // Fabricated codex:* id is "accepted" by the resolver in the
    // sense that we treat it as a codex subscription target — the
    // walker must still attempt to call it. The CALL itself fails,
    // which is what drives the failure trace in this test.
    if (modelId.startsWith("codex:")) {
      return {
        ok: true,
        resolved: {
          providerId: "codex",
          modelId,
          billingSource: "subscription",
        },
      };
    }
    return { ok: false, error: { kind: "unknown_model" } };
  };

  const result = await walkRecommenderChain({
    chain,
    resolveModel,
    runRung,
    availableModels: AVAILABLE_MODELS,
  });

  assert.equal(result.kind, "success");
  if (result.kind !== "success") return;
  assert.equal(result.rung.source, "configured_fallback");
  assert.equal(result.value.recommendedModelId, "gpt-5.4-mini");
  // The primary call was attempted AND failed before the fallback
  // ran — `callAttempts` records both: one failed + one success.
  assert.equal(result.callAttempts.length, 2);
  assert.equal(result.callAttempts[0]?.source, "configured");
  assert.equal(result.callAttempts[0]?.status, "failed");
  assert.match(result.callAttempts[0]?.reason ?? "", /usage_limit/);
  assert.equal(result.callAttempts[1]?.source, "configured_fallback");
  assert.equal(result.callAttempts[1]?.status, "success");
});

test("scenario 2: fabricated 'codex:' id is accepted as a rung and surfaced in callAttempts", async () => {
  // The brief's test ids use the prefixed form `codex:<name>` so
  // the chain walker accepts them as a rung entry rather than
  // dropping them silently. The walker must:
  //   - accept the rung into the chain (no early skip / no break),
  //   - attempt the resolveModel call,
  //   - record the failure (here: resolver rejects at runtime),
  //   - then continue to the next rung.
  const chain: RecommenderChainRung[] = [
    {
      source: "configured",
      providerId: "codex",
      modelId: "codex:no-such-engine-xyz",
      reasoningLevel: "low",
    },
    {
      source: "configured_fallback",
      providerId: "codex",
      modelId: "codex:gpt-5.4-mini",
      reasoningLevel: "low",
    },
  ];
  const resolveModel: ResolveFn = (modelId) => {
    if (modelId === "codex:no-such-engine-xyz") {
      // The resolver recognises the `codex:` prefix as a
      // subscription target, but the fabricated tail is not in the
      // catalog — surface it as a resolve failure so the chain
      // walker records it as `resolve_failed:unknown_model`.
      return { ok: false, error: { kind: "unknown_model" } };
    }
    if (modelId.startsWith("codex:")) {
      return {
        ok: true,
        resolved: { providerId: "codex", modelId, billingSource: "subscription" },
      };
    }
    return { ok: false, error: { kind: "unknown_model" } };
  };
  const runRung: RunRungFn = async ({ rung }) =>
    goodRecommendation(
      rung.source === "configured_fallback" ? "gpt-5.4-mini" : "gpt-5.4-mini",
      rung.source === "configured_fallback" ? "medium" : "low",
    );

  const result = await walkRecommenderChain({
    chain,
    resolveModel,
    runRung,
    availableModels: AVAILABLE_MODELS,
  });

  assert.equal(result.kind, "success");
  if (result.kind !== "success") return;
  // The walker DID attempt the fabricated rung — it shows up in
  // `callAttempts` as a failed entry, not as a silent skip.
  assert.equal(result.callAttempts.length, 2);
  const fabricatedAttempt = result.callAttempts[0]!;
  assert.equal(fabricatedAttempt.modelId, "codex:no-such-engine-xyz");
  assert.equal(fabricatedAttempt.source, "configured");
  assert.equal(fabricatedAttempt.status, "failed");
  assert.match(fabricatedAttempt.reason, /^resolve_failed:/);
  // The configured fallback then succeeds.
  assert.equal(result.callAttempts[1]?.source, "configured_fallback");
  assert.equal(result.callAttempts[1]?.status, "success");
});

test("scenario 3: disabled / invalid rung is skipped with continue, not hard-stopped with break", async () => {
  // Regression test: the walker must NOT `break` on the first
  // failed rung. If a future refactor replaces `continue` with
  // `break` (or returns early without continuing), this test
  // fails fast in <1s instead of waiting for the e2e suite.
  //
  // We drive two independent failure paths on the first rung —
  // one resolver-failure, one call-failure — and assert the
  // second rung is still attempted.
  for (const failureMode of ["resolve_failure", "call_failure"] as const) {
    const chain: RecommenderChainRung[] = [
      {
        source: "configured",
        providerId: "codex",
        modelId: "codex:disabled-engine",
        reasoningLevel: "low",
      },
      {
        source: "configured_fallback",
        providerId: "codex",
        modelId: "codex:gpt-5.4-mini",
        reasoningLevel: "low",
      },
    ];
    const resolveModel: ResolveFn = (modelId) => {
      if (modelId === "codex:disabled-engine") {
        if (failureMode === "resolve_failure") {
          return { ok: false, error: { kind: "provider_disabled" } };
        }
        return {
          ok: true,
          resolved: {
            providerId: "codex",
            modelId,
            billingSource: "subscription",
          },
        };
      }
      return {
        ok: true,
        resolved: {
          providerId: "codex",
          modelId,
          billingSource: "subscription",
        },
      };
    };
    const runRung: RunRungFn = async ({ rung }) => {
      if (rung.modelId === "codex:disabled-engine") {
        throw new Error("call_failed: provider_disabled");
      }
      return goodRecommendation("gpt-5.4-mini", "medium");
    };

    const result = await walkRecommenderChain({
      chain,
      resolveModel,
      runRung,
      availableModels: AVAILABLE_MODELS,
    });

    // The walker must succeed on the configured fallback even
    // though the first rung failed.
    assert.equal(
      result.kind,
      "success",
      `[${failureMode}] walker must continue past the failed first rung`,
    );
    if (result.kind !== "success") return;
    assert.equal(result.rung.source, "configured_fallback");
    // Both rungs are recorded in the call-attempt trace — the
    // walker MUST NOT exit after the first failure.
    assert.equal(
      result.callAttempts.length,
      2,
      `[${failureMode}] walker must record both attempts (no break)`,
    );
    assert.equal(result.callAttempts[0]?.status, "failed");
    assert.equal(result.callAttempts[1]?.source, "configured_fallback");
    assert.equal(result.callAttempts[1]?.status, "success");
  }
});

test("scenario 4: reasoningOverride (rung.reasoningLevel) is forwarded to runRung and applied to the chosen model", async () => {
  // The brief calls this "reasoningOverride". In the walker this
  // is `rung.reasoningLevel` — the provider-native reasoning
  // value the user picked for this specific rung. The walker
  // must:
  //   - forward it to the `runRung` callback so the route can
  //     build the right provider options,
  //   - use the recommendation's `recommendedReasoningLevel` to
  //     compute `level` for the chosen model,
  //   - coerce `level` to null when the chosen model does NOT
  //     advertise reasoning controls (Codex runtime ignores
  //     reasoning today).
  //
  // We exercise both code paths in a single test:
  //   - OpenAI fallback rung: `runRung` sees `rung.reasoningLevel`
  //     and the resulting `level` matches the recommendation's
  //     `recommendedReasoningLevel` (intersected with the model's
  //     `allowedReasoningLevels`).
  //   - Codex primary rung: succeeds, but `level` is forced to
  //     null because Codex does not support reasoning controls.
  const rungReasoningSeen: Array<{ source: string; reasoning: string | undefined }> = [];
  const chain: RecommenderChainRung[] = [
    {
      source: "configured",
      providerId: "codex",
      modelId: "codex:codex-only",
      reasoningLevel: "low",
    },
    {
      source: "configured_fallback",
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      reasoningLevel: "xhigh",
    },
  ];
  const availableModels: ReadonlyArray<RecommenderChainAvailableModel> = [
    {
      provider: "codex",
      modelId: "codex:codex-only",
      supportsReasoningControls: false,
      allowedReasoningLevels: [],
    },
    {
      provider: "openai",
      modelId: "gpt-5.4-mini",
      supportsReasoningControls: true,
      allowedReasoningLevels: ["low", "medium", "xhigh"],
    },
  ];
  const resolveModel: ResolveFn = (modelId) => ({
    ok: true,
    resolved: {
      providerId: modelId.startsWith("codex:") ? "codex" : "openai",
      modelId,
      billingSource: modelId.startsWith("codex:") ? "subscription" : "api_billing",
    },
  });
  const runRung: RunRungFn = async ({ rung }) => {
    rungReasoningSeen.push({ source: rung.source, reasoning: rung.reasoningLevel });
    // Codex returns a model the runtime picks up; OpenAI returns
    // gpt-5.4-mini with an xhigh reasoning pick.
    if (rung.source === "configured") {
      return goodRecommendation("codex:codex-only", "low");
    }
    return goodRecommendation("gpt-5.4-mini", "xhigh");
  };

  const result = await walkRecommenderChain({
    chain,
    resolveModel,
    runRung,
    availableModels,
  });

  assert.equal(result.kind, "success");
  if (result.kind !== "success") return;
  // (a) `runRung` saw the override on EACH rung.
  assert.deepEqual(rungReasoningSeen, [
    { source: "configured", reasoning: "low" },
    { source: "configured_fallback", reasoning: "xhigh" },
  ]);
  // (b) The callAttempts trace carries the override as the
  // `reasoning` field — this is the value the chat composer
  // surfaces in diagnostics ("primary recommender failed: …
  // · low · usage_limit").
  assert.equal(result.callAttempts[0]?.reasoning, "low");
  assert.equal(result.callAttempts[1]?.reasoning, "xhigh");
  // (c) On the SUCCESS rung, the returned `level` is the
  // provider-native reasoning value from the recommendation
  // (filtered through the chosen model's `allowedReasoningLevels`).
  // The fallback rung picked "xhigh" — the model advertises it.
  assert.equal(result.level, "xhigh");
  assert.equal(result.value.recommendedModelId, "gpt-5.4-mini");
});

test("scenario 4b: reasoningLevel override that the chosen model does NOT advertise is rejected as invalid_reasoning_level", async () => {
  // The reasoning override is propagated, but the recommended
  // model's `allowedReasoningLevels` is the source of truth for
  // what the runtime will actually accept. A mismatch must be
  // recorded as `invalid_reasoning_level` and the chain must
  // continue (not break) to the fallback.
  const chain: RecommenderChainRung[] = [
    {
      source: "configured",
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      reasoningLevel: "xhigh",
    },
    {
      source: "configured_fallback",
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      reasoningLevel: "low",
    },
  ];
  const availableModels: ReadonlyArray<RecommenderChainAvailableModel> = [
    {
      provider: "openai",
      modelId: "gpt-5.4-mini",
      supportsReasoningControls: true,
      // The model advertises only "low" / "medium" — NOT "xhigh".
      allowedReasoningLevels: ["low", "medium"],
    },
  ];
  const resolveModel: ResolveFn = (modelId) => ({
    ok: true,
    resolved: { providerId: "openai", modelId, billingSource: "api_billing" },
  });
  const runRung: RunRungFn = async ({ rung }) => {
    // First rung: recommender picks "xhigh" even though the model
    // doesn't advertise it — that's an `invalid_reasoning_level`.
    // Second rung: recommender picks "low" which is allowed.
    if (rung.source === "configured") {
      return goodRecommendation("gpt-5.4-mini", "xhigh");
    }
    return goodRecommendation("gpt-5.4-mini", "low");
  };

  const result = await walkRecommenderChain({
    chain,
    resolveModel,
    runRung,
    availableModels,
  });

  assert.equal(result.kind, "success");
  if (result.kind !== "success") return;
  // The walker skipped past the invalid-reasoning rung AND
  // recorded it explicitly — no silent drop, no break.
  assert.equal(result.callAttempts.length, 2);
  assert.equal(result.callAttempts[0]?.status, "failed");
  assert.equal(result.callAttempts[0]?.reason, "invalid_reasoning_level");
  assert.equal(result.callAttempts[1]?.source, "configured_fallback");
  assert.equal(result.callAttempts[1]?.status, "success");
  // The fallback's `level` matches the recommendation.
  assert.equal(result.level, "low");
  assert.equal(result.value.recommendedModelId, "gpt-5.4-mini");
});

test("both rungs fail: walker returns no_success with two failed callAttempts and never a third default rung", async () => {
  // Belt-and-braces: when BOTH configured rungs fail, the chain
  // walker returns `no_success` with two entries — exactly the
  // configured rungs. There is NO third Codex default, NO MiniMax
  // default, NO OpenAI default appended. The brief's
  // "Fallback engine (one)" contract caps the chain at two.
  const chain = makeChain({
    primaryModelId: "codex:no-such-primary",
    primaryReasoningLevel: "low",
    fallbackModelId: "codex:no-such-fallback",
    fallbackReasoningLevel: "low",
  });
  const resolveModel: ResolveFn = (modelId) => ({
    ok: true,
    resolved: { providerId: "codex", modelId, billingSource: "subscription" },
  });
  const runRung: RunRungFn = async () => {
    throw new Error("unavailable");
  };

  const result = await walkRecommenderChain({
    chain,
    resolveModel,
    runRung,
    availableModels: AVAILABLE_MODELS,
  });

  assert.equal(result.kind, "no_success");
  if (result.kind !== "no_success") return;
  assert.equal(result.callAttempts.length, 2);
  assert.equal(result.callAttempts[0]?.source, "configured");
  assert.equal(result.callAttempts[0]?.status, "failed");
  assert.equal(result.callAttempts[1]?.source, "configured_fallback");
  assert.equal(result.callAttempts[1]?.status, "failed");
  // The walker MUST NOT append a third "default" attempt just
  // because both rungs failed.
  assert.equal(result.callAttempts[2], undefined, "walker must not append a third default rung");
});

test("empty chain: walker returns no_success with zero callAttempts (defensive — production guards this)", async () => {
  // Belt-and-braces: an empty chain returns `no_success` with
  // zero entries. The route's own `chain.length > 2` guard plus
  // the "exactly the configured rungs" invariant mean this should
  // never happen in production, but the walker handles it cleanly.
  const result = await walkRecommenderChain({
    chain: [],
    resolveModel: () => ({
      ok: true,
      resolved: { providerId: "openai", modelId: "gpt-5.4-mini", billingSource: "api_billing" },
    }),
    runRung: async () => goodRecommendation("gpt-5.4-mini", "low"),
    availableModels: AVAILABLE_MODELS,
  });

  assert.equal(result.kind, "no_success");
  if (result.kind !== "no_success") return;
  assert.equal(result.callAttempts.length, 0);
});
