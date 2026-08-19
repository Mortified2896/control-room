import "server-only";

import type { BillingSource, ProviderId } from "./types";

/**
 * Map a (providerId, modelId) pair to its coarse billing source.
 *
 * The mapping is intentionally narrow — the no-API-billing-fallback
 * policy (see `lib/policy/no-api-billing-fallback.ts`) only needs to
 * distinguish "subscription-backed" (Codex, MiniMax) from "API-billed"
 * (OpenAI). Anything unrecognised defaults to `api_billing` so the
 * policy is fail-closed: a new provider that ships without an explicit
 * override can never silently satisfy a subscription-only fallback.
 *
 * Per the user-curated naming rule (MiniMax is a subscription path,
 * not an API-key fallback), both `minimax` and `codex` resolve to
 * `subscription` regardless of whether `MINIMAX_API_KEY` is set —
 * the env key is the auth secret for the subscription, not a billing
 * trigger. OpenAI remains `api_billing` because every `gpt-*` model
 * id is paid per-token.
 */
export function getBillingSourceForProvider(
  providerId: ProviderId,
  _modelId?: string,
): BillingSource {
  switch (providerId) {
    case "codex":
    case "minimax":
      return "subscription";
    case "openai":
      return "api_billing";
  }
}

/**
 * True iff a model on this provider is paid per token / per request
 * (i.e. it would consume a real-world budget when called). This is
 * the predicate the no-API-billing-fallback policy uses to gate
 * automatic substitutions.
 */
export function isApiBilling(providerId: ProviderId, modelId?: string): boolean {
  return getBillingSourceForProvider(providerId, modelId) === "api_billing";
}
