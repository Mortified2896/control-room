import { createOpenAI, openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { getMiniMaxConfig, MINIMAX_DISABLED_REASON } from "./minimax";
import type { ProviderId, ResolvedModel } from "./types";
import type { ReasoningCapability } from "./capability";

/**
 * Provider-native thinking-mode pick for thinking-budget models. The
 * value is sent verbatim to the provider — no renaming. When the
 * capability's `modes` list does not include the user's pick, the
 * runtime treats the pick as stale and falls back to the capability's
 * `defaultMode` (or omits the field entirely when neither is set).
 *
 * The shape is intentionally provider-agnostic: the runtime adapter
 * translates the value into the provider-specific wire format
 * (MiniMax / OpenRouter-compatible `reasoning: { enabled }` payload,
 * Anthropic `thinking: { type }` block, etc.).
 */
export type ThinkingMode = string;

/**
 * Provider-native reasoning / thinking option picked by the user for
 * an effort-level model. Sent verbatim to the provider — no
 * renaming. Examples: `"low"`, `"medium"`, `"xhigh"`, `"none"`,
 * `"minimal"`.
 */
export type ReasoningOptionValue = string;

export type RuntimeProviderOptions =
  | {
      openai: {
        /**
         * Provider-native reasoning-effort value, sent verbatim.
         * Examples: `"low"`, `"medium"`, `"high"`, `"xhigh"`.
         */
        reasoningEffort: ReasoningOptionValue;
      };
    }
  | {
      /**
       * MiniMax / OpenRouter-compatible reasoning payload. Used when
       * the selected model advertises a `thinking_budget` capability
       * and the user picked an explicit thinking mode. We omit this
       * block entirely when the mode is the provider default, when
       * the capability is model-dependent / unknown, or when the
       * provider does not advertise an `enabled` toggle.
       */
      minimax: {
        reasoning: {
          enabled?: boolean;
        };
      };
    }
  | undefined;

export class ProviderConfigurationError extends Error {
  readonly providerId: ProviderId;

  constructor(providerId: ProviderId, message: string) {
    super(message);
    this.name = "ProviderConfigurationError";
    this.providerId = providerId;
  }
}

export function getRuntimeModel(resolved: ResolvedModel): LanguageModel {
  if (resolved.providerId === "openai") {
    return openai(resolved.modelId) as unknown as LanguageModel;
  }

  if (resolved.providerId === "minimax") {
    const config = getMiniMaxConfig();
    if (!config.apiKey) {
      throw new ProviderConfigurationError("minimax", MINIMAX_DISABLED_REASON);
    }
    const minimax = createOpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    return minimax(resolved.modelId) as unknown as LanguageModel;
  }

  // `codex` and any other non-OpenAI/MiniMax providerId reach here.
  // Codex uses its own transport (CodexChatPane in `app/assistant.tsx`)
  // and never calls `/api/chat`, so a codex id in this route is a
  // stale persisted preference. Surface a clear error so the user can
  // see why and switch models.
  throw new ProviderConfigurationError(
    resolved.providerId,
    `Provider "${resolved.providerId}" is not implemented in /api/chat. Codex models use the dedicated Codex agent backend.`,
  );
}

/**
 * Capability-aware runtime provider options.
 *
 * The chat composer sends a single `reasoningOption` (provider-native
 * value, e.g. `"low"`, `"xhigh"`, `"adaptive"`, `"enabled"`) plus, for
 * thinking-budget models, a separate `thinkingMode`. The runtime
 * adapter chooses the right wire payload:
 *
 *   - OpenAI API model with `effort_levels + supported` or
 *     `+ model_dependent` → `{ openai: { reasoningEffort: <raw> } }`.
 *     The value flows through to the provider verbatim — we do not
 *     rename `xhigh` to `high` or hide `minimal` / `none`.
 *   - OpenAI API model with `effort_levels + unknown` →
 *     `undefined`. We do not invent an effort value the model may
 *     not accept.
 *   - OpenAI API model with non-effort-level capability
 *     (`thinking_budget`, `none`, `unknown`) → `undefined`. The
 *     provider-native option is rejected by access-control upstream.
 *   - MiniMax model with `thinking_budget + supported` and a
 *     non-default thinking mode → `{ minimax: { reasoning: { enabled
 *     } } }`. We translate the provider-native mode into the
 *     MiniMax / OpenRouter-compatible wire shape:
 *       - `"enabled"`  → `enabled: true`
 *       - `"disabled"` → `enabled: false`
 *       - other modes (`"adaptive"`, `"provider_default"`, …) flow
 *         through as the runtime supports them.
 *     When `thinkingMode` is `"provider_default"` (or empty), we omit
 *     the block so the provider uses its own default.
 *   - MiniMax model with `thinking_budget + model_dependent` or
 *     `+ unknown` → `undefined`. We do not trust an explicit pick
 *     for a capability we cannot verify.
 *   - Codex / other non-OpenAI/MiniMax → the chat route throws
 *     `ProviderConfigurationError` upstream of this function.
 *
 * Stale-value handling: when `reasoningOption` is no longer in the
 * capability's `options` list (e.g. after a provider refresh
 * removed or renamed it), the chat route's access-control layer
 * rejects the request before we get here, so this function only
 * sees valid values.
 */
export function getRuntimeProviderOptions(args: {
  resolved: ResolvedModel;
  capability: ReasoningCapability;
  reasoningOption: ReasoningOptionValue;
  thinkingMode?: ThinkingMode;
}): RuntimeProviderOptions {
  const { resolved, capability, reasoningOption, thinkingMode } = args;
  if (resolved.providerId === "openai") {
    if (capability.kind !== "effort_levels") {
      // OpenAI models with a non-effort-level capability (none,
      // thinking_budget, unknown) — omit reasoning options rather
      // than shipping a `reasoningEffort` the model may ignore.
      return undefined;
    }
    if (capability.control === "unknown") {
      // We have no concrete option list — omit rather than ship a
      // value the model may not accept.
      return undefined;
    }
    // Send the provider-native value verbatim. We do NOT narrow it
    // to a fixed enum — Codex `xhigh`, MiniMax-mapped `minimal`,
    // and any future provider-native value flow through unchanged.
    return { openai: { reasoningEffort: reasoningOption } };
  }
  if (resolved.providerId === "minimax") {
    if (capability.kind !== "thinking_budget") return undefined;
    if (capability.control === "unknown" || capability.control === "model_dependent") {
      // We don't trust the user pick enough to silently override the
      // provider default. Returning `undefined` lets the provider
      // decide.
      return undefined;
    }
    const mode = (thinkingMode ?? "").trim();
    if (mode === "" || mode === "provider_default") return undefined;
    if (mode === "enabled") {
      return { minimax: { reasoning: { enabled: true } } };
    }
    if (mode === "disabled") {
      return { minimax: { reasoning: { enabled: false } } };
    }
    // Any other provider-native mode (`"adaptive"`, etc.) — omit
    // rather than invent a wire shape. A future translator here can
    // map known extra modes into MiniMax's reasoning payload.
    return undefined;
  }
  return undefined;
}
