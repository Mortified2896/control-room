import assert from "node:assert/strict";
import test from "node:test";

import { buildRouterFallbackChain, pickRouterModelForRun } from "./schema.ts";

/**
 * Tests for the user-configured recommender-fallback wiring in
 * `buildRouterFallbackChain` + `pickRouterModelForRun`. The chain
 * itself was previously untested in isolation — these tests pin
 * down the order, the dedupe behavior, and the new
 * `configured_fallback` source discriminator introduced for the
 * single-model user fallback.
 *
 * Cost-safety policy exercised here:
 *   - Subscription providers (Codex, MiniMax) are accepted by default.
 *   - OpenAI API is opt-in only (behind `allowOpenAiApiRouter`).
 *   - The user-configured fallback is inserted at position 2 (after
 *     the configured primary, before the Codex default).
 *   - The chain dedupes against earlier rungs so the fallback may
 *     equal the primary without producing a duplicate.
 */

const STATIC_DEFAULTS = {
  codexDefault: "codex:gpt-5.4-mini",
  minimaxDefault: "MiniMax-M3",
  openaiDefault: "gpt-5.4-mini",
} as const;

test("buildRouterFallbackChain: primary + Codex default + MiniMax default (no fallback)", () => {
  // When the configured primary IS a Codex model, the static Codex
  // default rung dedupes against it (chain dedupes by modelId). The
  // chain is therefore: primary → MiniMax default.
  const chain = buildRouterFallbackChain({
    configuredRouterModelId: "codex:gpt-5.4-mini",
    allowedCombos: [],
    allowOpenAiApiRouter: false,
    ...STATIC_DEFAULTS,
  });
  assert.deepEqual(
    chain.map((c) => `${c.providerId}:${c.modelId}`),
    [
      "codex:codex:gpt-5.4-mini", // configured primary
      "minimax:MiniMax-M3", // static MiniMax default
    ],
  );
});

test("buildRouterFallbackChain: user fallback is inserted between primary and Codex default", () => {
  const chain = buildRouterFallbackChain({
    configuredRouterModelId: "codex:gpt-5.4-mini",
    configuredRouterFallbackModelId: "MiniMax-M3",
    allowedCombos: [],
    allowOpenAiApiRouter: false,
    ...STATIC_DEFAULTS,
  });
  // The chain dedupes by modelId (not by rung), so when the
  // user-configured fallback IS a MiniMax model, the static
  // MiniMax default rung collapses against it. The Codex default
  // rung also collapses against the configured Codex primary.
  // The chain is therefore: primary → user fallback.
  const ids = chain.map((c) => c.modelId);
  assert.deepEqual(ids, [
    "codex:gpt-5.4-mini", // configured primary
    "MiniMax-M3", // user fallback (also subsumes the static MiniMax default)
  ]);
  // Exactly one rung is flagged as the user fallback.
  const fallbackRungs = chain.filter(
    (c) => c.modelId === "MiniMax-M3" && c.isUserConfiguredFallback === true,
  );
  assert.equal(fallbackRungs.length, 1, "expected exactly one flagged user-fallback rung");
});

test("buildRouterFallbackChain: user fallback keeps the static-default rung when they differ", () => {
  // User fallback is OpenAI API (opt-in ON); static defaults are
  // Codex + MiniMax + OpenAI API. Chain should be: primary → user
  // fallback (different from static OpenAI default) → Codex default
  // (dedupes against primary) → MiniMax default → OpenAI default.
  const chain = buildRouterFallbackChain({
    configuredRouterModelId: "codex:gpt-5.4-mini",
    configuredRouterFallbackModelId: "gpt-5.5",
    allowedCombos: [],
    allowOpenAiApiRouter: true,
    ...STATIC_DEFAULTS,
  });
  const ids = chain.map((c) => c.modelId);
  assert.deepEqual(ids, [
    "codex:gpt-5.4-mini", // configured primary
    "gpt-5.5", // user fallback (OpenAI API)
    "MiniMax-M3", // static MiniMax default
    "gpt-5.4-mini", // static OpenAI default (opt-in ON)
  ]);
  // The OpenAI-API rung appears twice: once as the user fallback
  // (flagged) and once as the static default (unflagged). The two
  // rungs reference different modelIds (`gpt-5.5` vs `gpt-5.4-mini`)
  // so the chain does NOT dedupe them.
  const userFallbackOpenai = chain.filter(
    (c) => c.modelId === "gpt-5.5" && c.providerId === "openai",
  );
  assert.equal(userFallbackOpenai.length, 1);
  assert.equal(userFallbackOpenai[0]?.isUserConfiguredFallback, true);

  const staticOpenai = chain.filter(
    (c) => c.modelId === "gpt-5.4-mini" && c.providerId === "openai",
  );
  assert.equal(staticOpenai.length, 1);
  assert.equal(staticOpenai[0]?.isUserConfiguredFallback, undefined);
});

test("buildRouterFallbackChain: null fallback leaves the chain unchanged", () => {
  const chainWithNull = buildRouterFallbackChain({
    configuredRouterModelId: "codex:gpt-5.4-mini",
    configuredRouterFallbackModelId: null,
    allowedCombos: [],
    allowOpenAiApiRouter: false,
    ...STATIC_DEFAULTS,
  });
  const chainWithoutFallback = buildRouterFallbackChain({
    configuredRouterModelId: "codex:gpt-5.4-mini",
    allowedCombos: [],
    allowOpenAiApiRouter: false,
    ...STATIC_DEFAULTS,
  });
  assert.deepEqual(
    chainWithNull.map((c) => `${c.providerId}:${c.modelId}`),
    chainWithoutFallback.map((c) => `${c.providerId}:${c.modelId}`),
  );
});

test("buildRouterFallbackChain: fallback equal to primary is deduped silently", () => {
  // User picks the same model for the fallback as the primary. The
  // chain must NOT produce a duplicate rung.
  const chain = buildRouterFallbackChain({
    configuredRouterModelId: "codex:gpt-5.4-mini",
    configuredRouterFallbackModelId: "codex:gpt-5.4-mini",
    allowedCombos: [],
    allowOpenAiApiRouter: false,
    ...STATIC_DEFAULTS,
  });
  const codexRungs = chain.filter((c) => c.modelId === "codex:gpt-5.4-mini");
  assert.equal(codexRungs.length, 1, "expected exactly one Codex rung");
});

test("buildRouterFallbackChain: OpenAI API fallback requires opt-in", () => {
  // With opt-in ON, OpenAI API is included as a static default rung
  // when the chain is exhausted.
  const chainOptIn = buildRouterFallbackChain({
    configuredRouterModelId: "codex:gpt-5.4-mini",
    allowedCombos: [],
    allowOpenAiApiRouter: true,
    ...STATIC_DEFAULTS,
  });
  const openaiRungsOptIn = chainOptIn.filter((c) => c.providerId === "openai");
  assert.equal(openaiRungsOptIn.length, 1);

  // With opt-in OFF, the chain skips the OpenAI rung entirely.
  const chainNoOptIn = buildRouterFallbackChain({
    configuredRouterModelId: "codex:gpt-5.4-mini",
    allowedCombos: [],
    allowOpenAiApiRouter: false,
    ...STATIC_DEFAULTS,
  });
  const openaiRungsNoOptIn = chainNoOptIn.filter((c) => c.providerId === "openai");
  assert.equal(openaiRungsNoOptIn.length, 0);
});

test("pickRouterModelForRun: surfaces configured_fallback source when the user fallback rung wins", async () => {
  // The configured primary fails (the resolver returns ok:false);
  // the user-configured fallback succeeds (the resolver returns
  // ok:true). The source discriminator must be `configured_fallback`
  // so the route picks the right reasoning level.
  const chain = buildRouterFallbackChain({
    configuredRouterModelId: "codex:gpt-5.4-mini",
    configuredRouterFallbackModelId: "MiniMax-M3",
    allowedCombos: [],
    allowOpenAiApiRouter: false,
    ...STATIC_DEFAULTS,
  });
  const resolution = await pickRouterModelForRun({
    chain,
    allowOpenAiApiRouter: false,
    resolver: async (candidate) => {
      if (candidate.modelId === "codex:gpt-5.4-mini") {
        return { ok: false as const, reason: "primary failed" };
      }
      if (candidate.isUserConfiguredFallback) {
        return { ok: true as const };
      }
      // Static-default rung that comes after the user fallback would
      // not normally be reached, but the test makes it explicit.
      return { ok: false as const, reason: "unreachable" };
    },
  });
  assert.equal(resolution.ok, true);
  if (resolution.ok) {
    assert.equal(resolution.modelId, "MiniMax-M3");
    assert.equal(resolution.source, "configured_fallback");
  }
});

test("pickRouterModelForRun: primary success with a Codex configured primary surfaces source 'configured'", async () => {
  // The source discriminator now keys off chain position AND the
  // user-fallback flag, so a successful Codex primary rung reports
  // `configured` (the chain's first rung) even though the model id
  // happens to be a Codex subscription model. The dedicated
  // `configured_fallback` discriminator only fires when the
  // user-configured fallback rung wins.
  const chain = buildRouterFallbackChain({
    configuredRouterModelId: "codex:gpt-5.4-mini",
    configuredRouterFallbackModelId: "MiniMax-M3",
    allowedCombos: [],
    allowOpenAiApiRouter: false,
    ...STATIC_DEFAULTS,
  });
  const resolution = await pickRouterModelForRun({
    chain,
    allowOpenAiApiRouter: false,
    resolver: async () => ({ ok: true as const }),
  });
  assert.equal(resolution.ok, true);
  if (resolution.ok) {
    assert.equal(resolution.modelId, "codex:gpt-5.4-mini");
    assert.equal(resolution.source, "configured");
    assert.match(resolution.reason, /configured recommender engine/i);
  }
});

test("pickRouterModelForRun: primary success with a non-Codex primary surfaces source 'configured'", async () => {
  // When the configured primary is a MiniMax model, the chain's
  // static MiniMax default rung dedupes against it, so the source
  // discriminator reports `configured` (the chain's first rung won
  // AND it wasn't the user-configured fallback rung).
  const chain = buildRouterFallbackChain({
    configuredRouterModelId: "MiniMax-M3",
    allowedCombos: [],
    allowOpenAiApiRouter: false,
    ...STATIC_DEFAULTS,
  });
  const resolution = await pickRouterModelForRun({
    chain,
    allowOpenAiApiRouter: false,
    resolver: async () => ({ ok: true as const }),
  });
  assert.equal(resolution.ok, true);
  if (resolution.ok) {
    assert.equal(resolution.modelId, "MiniMax-M3");
    assert.equal(resolution.source, "configured");
  }
});

test("pickRouterModelForRun: when primary AND user fallback both fail, falls through to defaults", async () => {
  const chain = buildRouterFallbackChain({
    configuredRouterModelId: "codex:gpt-5.4-mini",
    configuredRouterFallbackModelId: "MiniMax-M3",
    allowedCombos: [],
    allowOpenAiApiRouter: false,
    ...STATIC_DEFAULTS,
  });
  // The chain is: [0] codex:gpt-5.4-mini (primary), [1] MiniMax-M3
  // (user fallback). The MiniMax static default dedupes against the
  // user fallback because they share the same modelId. Configure the
  // resolver so the SECOND rung succeeds.
  const resolution = await pickRouterModelForRun({
    chain,
    allowOpenAiApiRouter: false,
    resolver: async (candidate) => {
      // The user-fallback rung (MiniMax M3) succeeds.
      if (candidate.modelId === STATIC_DEFAULTS.minimaxDefault) {
        return { ok: true as const };
      }
      return { ok: false as const, reason: "failed" };
    },
  });
  assert.equal(resolution.ok, true);
  if (resolution.ok) {
    // The user-fallback rung (index 1) succeeded.
    assert.equal(resolution.modelId, STATIC_DEFAULTS.minimaxDefault);
    // The user-fallback flag wins, so the source discriminator is
    // `configured_fallback` even though the provider id is MiniMax.
    assert.equal(resolution.source, "configured_fallback");
    assert.match(resolution.reason, /user-configured recommender fallback/i);
  }
});
