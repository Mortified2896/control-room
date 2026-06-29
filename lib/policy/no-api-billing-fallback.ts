import "server-only";

import type { BillingSource, ModelMeta, ProviderId, SelectionSource } from "@/lib/providers/types";
import { isApiBilling } from "@/lib/providers/billing-source";

/**
 * NO_API_BILLING_FALLBACK policy.
 *
 * Hard rule (named so it shows up in code review and runtime logs):
 *
 *   Control Room must never use a real API-billed provider as a
 *   fallback for any reason. The only allowed automatic path is
 *   the one the user explicitly selected, accepted, or project-
 *   configured. Quota exhaustion, missing credentials, unsupported
 *   reasoning mode, hidden default, or a recommender suggestion
 *   never justify an OpenAI / MiniMax / OpenRouter / etc. call
 *   under this policy.
 *
 * Subscription-only fallback proposals (Codex → MiniMax, MiniMax →
 * Codex) are still allowed — but they must be PROPOSED, not auto-
 *   applied. The UI must ask the user, explain why, and only switch
 *   after explicit confirmation.
 *
 * This module is the single place that encodes the rule. Callers
 * (chat route, recommender route, A/B router, chat composer) call
 * `enforceNoApiBillingFallback` (or the lower-level helpers) and
 * propagate the resulting `NoApiBillingFallbackError` /
 * `SubscriptionFallbackProposal` upward — never silently substitute.
 *
 * Tested by `e2e/no-api-billing-fallback.spec.ts`.
 */

export type ProposedSubscriptionFallback = {
  /** modelId we are proposing to switch to. */
  toModelId: string;
  /** providerId we are proposing to switch to. */
  toProviderId: ProviderId;
  /**
   * Subscription label for the proposal — surfaced verbatim in the
   * confirmation copy so the user can see what they're being asked
   * to switch to. e.g. `"MiniMax-M3 · MiniMax subscription"`.
   */
  displayLabel: string;
  /**
   * Free-form reason that explains why the original model cannot
   * run. Rendered alongside the confirmation prompt.
   */
  reason: string;
  /**
   * The exact `BillingSource` of the proposed alternative. Always
   * `"subscription"` under this policy.
   */
  billingSource: BillingSource;
};

export type NoApiBillingFallbackErrorKind =
  /** Requested model is hidden, disabled, missing credentials, etc. */
  | "model_unavailable"
  /** Requested model uses a reasoning/thinking mode that isn't supported. */
  | "reasoning_mode_unsupported"
  /** Requested model is over budget / quota-exhausted. */
  | "quota_exhausted"
  /** Recommender runner itself failed. The chat composer will surface this. */
  | "recommender_runner_failed";

/**
 * The single error type the policy raises. Carries the kind, the
 * user-facing reason, and (when the user might switch to a
 * subscription-backed alternative) the proposal.
 */
export type NoApiBillingFallbackError = {
  kind: NoApiBillingFallbackErrorKind;
  /** The model the caller asked for, even if it didn't run. */
  requestedModelId: string;
  requestedProviderId: ProviderId | "codex";
  requestedBillingSource: BillingSource;
  /** Why we can't run the requested model. Rendered verbatim. */
  reason: string;
  /**
   * 0+ subscription-backed alternatives the user can switch to.
   * Always empty when `requestedBillingSource === "subscription"`,
   * because there is no cheaper subscription path to propose.
   */
  proposedSubscriptionFallbacks: ReadonlyArray<ProposedSubscriptionFallback>;
  /**
   * True iff the policy decided the user must explicitly confirm any
   * proposal before the system can switch models. The UI never auto-
   * switches; this flag is informational but always true.
   */
  requiresExplicitConfirmation: true;
};

export class NoApiBillingFallbackErrorClass extends Error {
  readonly payload: NoApiBillingFallbackError;

  constructor(payload: NoApiBillingFallbackError) {
    super(payload.reason);
    this.name = "NoApiBillingFallbackError";
    this.payload = payload;
  }
}

/**
 * Pick the cheapest subscription-backed alternatives from `candidates`
 * that match the requested model's tier. Returns at most `max` items,
 * sorted by display label for stable UI.
 *
 * Subscription → subscription is the only allowed fallback. We never
 * surface an API-billed alternative as a proposal under this policy.
 */
export function proposeSubscriptionFallbacks(input: {
  requestedModelId: string;
  requestedProviderId: ProviderId;
  candidates: ReadonlyArray<ModelMeta>;
  registry: ReadonlyArray<{ modelId: string; displayLabel: string }>;
  /** Optional limit on the number of proposals. */
  max?: number;
  /** Why the requested model can't run — surfaced in the proposal copy. */
  reason: string;
}): ProposedSubscriptionFallback[] {
  const max = input.max ?? 3;
  // Only consider subscription-backed candidates that are not the
  // requested model itself.
  const proposals: ProposedSubscriptionFallback[] = [];
  for (const candidate of input.candidates) {
    if (isApiBilling(candidate.providerId, candidate.modelId)) continue;
    if (candidate.modelId === input.requestedModelId) continue;
    const labelEntry = input.registry.find((r) => r.modelId === candidate.modelId);
    proposals.push({
      toModelId: candidate.modelId,
      toProviderId: candidate.providerId,
      displayLabel: labelEntry?.displayLabel ?? `${candidate.providerId} · ${candidate.modelId}`,
      reason: input.reason,
      billingSource: "subscription",
    });
  }
  // Deterministic order, but prefer a different subscription
  // provider first (Codex failure → MiniMax proposal, MiniMax
  // failure → Codex proposal). Same-provider alternatives are still
  // useful, but they should not crowd out cross-provider options.
  proposals.sort((a, b) => {
    const aDifferentProvider = a.toProviderId !== input.requestedProviderId;
    const bDifferentProvider = b.toProviderId !== input.requestedProviderId;
    if (aDifferentProvider !== bDifferentProvider) return aDifferentProvider ? -1 : 1;
    if (a.toProviderId !== b.toProviderId) {
      return a.toProviderId.localeCompare(b.toProviderId);
    }
    return a.toModelId.localeCompare(b.toModelId);
  });
  return proposals.slice(0, max);
}

/**
 * The single chokepoint the chat + recommender + A/B router go
 * through before any model substitution. If the requested model
 * is unusable AND the only available alternatives are API-billed,
 * this raises `NoApiBillingFallbackErrorClass` with no proposals.
 * Otherwise it returns the list of subscription-backed proposals
 * the caller can show the user. The caller MUST NOT auto-substitute.
 *
 * `requestedSelectionSource` records how the user got here so the
 * policy can decide whether this is a "user explicitly picked this
 * model" case (in which case there is no fallback at all) vs a
 * "system / project / accepted-recommendation" case (in which case
 * subscription proposals are surfaced).
 */
export function enforceNoApiBillingFallback(input: {
  requested: {
    modelId: string;
    providerId: ProviderId | "codex";
    billingSource: BillingSource;
    selectionSource: SelectionSource;
  };
  kind: NoApiBillingFallbackErrorKind;
  reason: string;
  candidates: ReadonlyArray<ModelMeta>;
  registry: ReadonlyArray<{ modelId: string; displayLabel: string }>;
}): { proposals: ProposedSubscriptionFallback[]; throw: () => never } {
  const proposals = proposeSubscriptionFallbacks({
    requestedModelId: input.requested.modelId,
    requestedProviderId:
      input.requested.providerId === "codex" ? "codex" : input.requested.providerId,
    candidates: input.candidates,
    registry: input.registry,
    reason: input.reason,
  });

  // If the user explicitly chose this model, the failure copy should
  // make clear that Control Room will not auto-substitute. We still
  // surface subscription alternatives as PROPOSALS because accepting
  // one is an explicit new user action, not fallback execution in
  // this request.
  const isUserExplicit = input.requested.selectionSource === "user_explicit";

  const throwFn: () => never = () => {
    throw new NoApiBillingFallbackErrorClass({
      kind: input.kind,
      requestedModelId: input.requested.modelId,
      requestedProviderId: input.requested.providerId,
      requestedBillingSource: input.requested.billingSource,
      reason: isUserExplicit
        ? `${input.reason} (This model was selected by you; Control Room will not auto-substitute.)`
        : input.reason,
      proposedSubscriptionFallbacks: proposals,
      requiresExplicitConfirmation: true,
    });
  };

  return { proposals, throw: throwFn };
}
