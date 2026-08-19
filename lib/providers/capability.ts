/**
 * Reasoning / thinking capability model.
 *
 * The capability model distinguishes:
 *
 *   1. OpenAI / Codex `reasoning_effort` style controls, which the
 *      provider exposes as a discrete list of named options. We do
 *      NOT normalize the values into a fixed enum like
 *      `low | medium | high` because providers (and Codex models)
 *      may also expose `none`, `minimal`, `xhigh`, or any other
 *      name the provider decides. We send and surface the exact
 *      provider-native values verbatim.
 *   2. Provider-native thinking / reasoning controls that do not fit
 *      the effort-level shape — MiniMax M3's thinking modes,
 *      Anthropic-style thinking blocks, etc.
 *
 * The capability carries `source` and `refreshedAt` so the UI can
 * show "Refreshed 5m ago" and the registry can record whether the
 * option set came from static metadata or a fresh provider
 * discovery. When a provider exposes reasoning metadata via its
 * discovery API, the refresh function in
 * `lib/providers/reasoning-refresh.ts` returns it; when it does
 * not, the static metadata wins.
 *
 * Backwards compatibility:
 *
 *   - The `reasoningLevels` and `supportedReasoningLevels` fields
 *     on `ModelOption` / `ModelMeta` / `EffectiveModelEntry` are
 *     retained as DERIVED fields. They are populated only for
 *     `kind: "effort_levels"` capabilities and carry the provider-
 *     native `option.value` strings (NOT a narrow `ReasoningLevel`
 *     enum). Callers that only need the raw values can keep reading
 *     them; callers that need the full option metadata should
 *     consult `reasoningCapability.options` directly.
 *   - The `reasoningLevels` field NEVER fakes `["low"]` for
 *     unknown capabilities. Unknown → empty.
 *
 * Adding a new provider family:
 *
 *   1. Add or extend a variant of `ReasoningCapability`.
 *   2. Add a constructor helper here.
 *   3. Wire it into the provider file (e.g. `minimax.ts`) and the
 *      registry merge layer.
 *   4. Add UI rendering in
 *      `components/assistant-ui/router-ab-controls.tsx` if the new
 *      variant needs a custom control surface.
 */

import type { ReasoningLevel } from "./types";

/**
 * Coarse-grained state for a reasoning capability.
 *
 *   - `supported`       — the model advertises this capability and
 *                         we know the concrete surface (specific
 *                         options or modes).
 *   - `model_dependent` — the underlying provider has this capability
 *                         but the concrete surface depends on the
 *                         exact model id we don't have static
 *                         metadata for. The runtime will pass the
 *                         user pick through to the provider; the UI
 *                         may render a conservative subset.
 *   - `unknown`         — we do not know whether this capability is
 *                         available. The UI must NOT fake options.
 *   - `unsupported`     — the provider / model does not support
 *                         reasoning controls at all.
 */
export type ReasoningControl = "supported" | "model_dependent" | "unknown" | "unsupported";

/**
 * A single provider-native reasoning option. The `value` is sent
 * verbatim to the provider and surfaced verbatim in the UI; we do
 * NOT rename or remap it.
 *
 * - `value`        — provider-native value, e.g. `"minimal"`, `"xhigh"`,
 *                    `"adaptive"`, `"enabled"`. Required.
 * - `label`        — optional friendly label for the UI. When omitted,
 *                    the picker renders the raw `value`. The raw value
 *                    is always available via `data-value` on the
 *                    rendered button so it can be inspected even when
 *                    a label is shown.
 * - `description`  — optional helper copy shown beneath the option.
 */
export type ReasoningOption = {
  value: string;
  label?: string;
  description?: string;
};

/**
 * Where a reasoning capability came from.
 *
 * - `static`           — set from local metadata in
 *                        `lib/providers/openai-static.ts` /
 *                        `codex-catalog.ts` / `minimax.ts`.
 * - `provider_refresh` — discovered from the provider's API on a
 *                        recent refresh. The options list is
 *                        authoritative until the next refresh.
 * - `manual`           — overridden by a Settings UI action. Used for
 *                        user-curated capability edits (future).
 */
export type ReasoningCapabilitySource = "static" | "provider_refresh" | "manual";

/**
 * Effort-level reasoning (OpenAI / Codex `reasoning_effort`).
 *
 * The `options` array carries the provider-native values. We do NOT
 * normalize the values into a fixed enum; providers may expose
 * `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or any other
 * name they choose. The runtime adapter sends the user's pick
 * through to the provider verbatim.
 *
 * `control` describes how confident we are in the `options` list:
 *
 *   - `supported`       — the model explicitly advertises these
 *                        options. Static metadata or a fresh provider
 *                        refresh produced this list.
 *   - `model_dependent` — `options` is a conservative default for
 *                        the provider family; the underlying model
 *                        may accept a wider set at runtime. We render
 *                        `options` in the UI but the request builder
 *                        trusts the pick.
 *   - `unknown`         — we have no reliable data. `options` MUST be
 *                        empty; the UI must not render fake options.
 */
export type EffortLevelsCapability = {
  kind: "effort_levels";
  control: "supported" | "model_dependent" | "unknown";
  options: ReasoningOption[];
  /**
   * Provider-native default option. Used by the UI as the chat
   * composer's initial pick, and by the runtime as a fallback when
   * the user's saved pick is no longer valid after a refresh.
   */
  defaultOption?: string;
  source?: ReasoningCapabilitySource;
  refreshedAt?: string;
};

/**
 * Provider-native thinking / reasoning controls (MiniMax M3, future
 * Anthropic-style thinking blocks, etc.).
 *
 * The booleans describe *which* sub-controls the model is known to
 * expose; they do not commit to a single wire format. The runtime
 * adapter (`getRuntimeProviderOptions` in `runtime.ts`) is responsible
 * for translating the user's pick into the provider-specific payload.
 *
 * `modes` carries the provider-native mode values (e.g.
 * `"provider_default"`, `"adaptive"`, `"enabled"`, `"disabled"`).
 * These are sent verbatim to the provider, never renamed.
 *
 * `defaultMode` is the safe default when the user has not picked
 * anything yet. When `control === "unknown"` we still know the
 * *family* (thinking-budget) but not the specifics, so `modes` may
 * be omitted and `defaultMode` is left to the provider.
 */
export type ThinkingBudgetCapability = {
  kind: "thinking_budget";
  control: "supported" | "model_dependent" | "unknown";
  /** Whether the model accepts an `enabled: true | false` toggle. */
  supportsEnabled?: boolean;
  /** Whether the model accepts a numeric `budget_tokens` field. */
  supportsTokenBudget?: boolean;
  /** Whether the model accepts an `exclude` list of tools / scopes. */
  supportsExclude?: boolean;
  /**
   * Provider-native thinking modes. When omitted (and `control !==
   * "unknown"`) the runtime can still build a request from the
   * boolean sub-controls; when `control === "unknown"` we omit
   * `modes` so the UI shows the "unknown" notice instead of fake
   * options.
   */
  modes?: ReasoningOption[];
  /** Provider-native default mode, when known. */
  defaultMode?: string;
  source?: ReasoningCapabilitySource;
  refreshedAt?: string;
};

export type NoReasoningCapability = {
  kind: "none";
  control: "unsupported";
  /**
   * Optional human-readable explanation, surfaced as a tooltip /
   * inline note when the UI hides the reasoning controls.
   */
  reason?: string;
};

/**
 * The registry has no data for this model id. We deliberately do NOT
 * default to `kind: "none"` — that would lie about unsupported
 * providers, and it would also lie about `effort_levels` support by
 * forcing the UI to render a single fake option. `unknown` keeps the
 * UI honest: it must show "Reasoning capability unknown" rather than
 * a fake dropdown.
 */
export type UnknownReasoningCapability = {
  kind: "unknown";
  control: "unknown";
  reason?: string;
};

export type ReasoningCapability =
  | EffortLevelsCapability
  | ThinkingBudgetCapability
  | NoReasoningCapability
  | UnknownReasoningCapability;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the legacy `reasoningLevels` array of provider-native option
 * values from a capability. Returns the concrete list of option
 * `value`s only when the capability is `kind: "effort_levels"` with
 * `control: "supported" | "model_dependent"`. Everything else
 * resolves to an empty array — including unknown, thinking_budget,
 * and none.
 *
 * This is the single function callers must use when they need a
 * backwards-compatible `string[]` shape. The values are NOT typed as
 * the narrow `ReasoningLevel` enum — they are provider-native
 * strings, so a Codex `xhigh` or MiniMax `adaptive` value flows
 * through unchanged.
 *
 * Never hardcode `["low"]` anywhere as a fallback — that is exactly
 * the lie this refactor removes.
 */
export function getEffectiveReasoningLevels(
  capability: ReasoningCapability,
): ReadonlyArray<string> {
  if (capability.kind === "effort_levels") {
    if (capability.control === "supported" || capability.control === "model_dependent") {
      return capability.options.map((o) => o.value);
    }
    return [];
  }
  return [];
}

/**
 * Coarse-grained "does this capability have any reasoning controls at
 * all?" test. Used by the registry merge layer to decide whether a
 * model is router-eligible and whether it can carry an effort-level
 * allowlist entry.
 *
 * `supported` and `model_dependent` both count as "supports reasoning";
 * `unknown` and `unsupported` do not. The `kind` is the tiebreaker
 * inside `unsupported`: `kind: "none"` is "definitely no", `kind:
 * "unknown"` is "we don't know, do not assume".
 */
export function hasReasoningControls(capability: ReasoningCapability): boolean {
  if (capability.control === "unsupported") return false;
  if (capability.control === "unknown") return false;
  return true;
}

/**
 * Return the provider-native option values available for an
 * effort-level capability. Returns an empty array for every other
 * kind. The values are NOT normalized — they flow through as the
 * provider advertised them.
 */
export function getEffortLevelOptionValues(capability: ReasoningCapability): ReadonlyArray<string> {
  if (capability.kind !== "effort_levels") return [];
  if (capability.control === "unknown") return [];
  return capability.options.map((o) => o.value);
}

/**
 * Return the provider-native thinking-mode values available for a
 * thinking-budget capability. Returns an empty array when the
 * capability does not advertise modes.
 */
export function getThinkingModeOptionValues(
  capability: ReasoningCapability,
): ReadonlyArray<string> {
  if (capability.kind !== "thinking_budget") return [];
  if (!capability.modes || capability.modes.length === 0) return [];
  if (capability.control === "unknown") return [];
  return capability.modes.map((o) => o.value);
}

export type ProviderNativeOptionChoice = {
  value: string;
  label: string;
  description?: string;
};

/**
 * Single source of truth for provider-native reasoning / thinking
 * selector options across Settings, Chat UI, and API prompt-building
 * surfaces. Never returns fake OpenAI-style `low` for MiniMax or
 * unknown models.
 */
export function getProviderNativeOptionChoices(
  capability: ReasoningCapability,
): ReadonlyArray<ProviderNativeOptionChoice> {
  if (capability.kind === "effort_levels") {
    if (capability.control === "supported" || capability.control === "model_dependent") {
      return capability.options.map((opt) => ({
        value: opt.value,
        label: opt.label ?? opt.value,
        ...(opt.description ? { description: opt.description } : {}),
      }));
    }
    return [{ value: "", label: "Unknown / provider default" }];
  }

  if (capability.kind === "thinking_budget") {
    const advertised = capability.modes ?? [];
    if (capability.control !== "unknown" && advertised.length > 0) {
      return advertised.map((mode) => ({
        value: mode.value,
        label: mode.label ?? mode.value,
        ...(mode.description ? { description: mode.description } : {}),
      }));
    }
    if (capability.control === "supported" || capability.control === "model_dependent") {
      return [
        { value: "provider_default", label: "provider_default" },
        { value: "adaptive", label: "adaptive" },
        { value: "enabled", label: "enabled" },
        { value: "disabled", label: "disabled" },
      ];
    }
    return [{ value: "provider_default", label: "Unknown / provider default" }];
  }

  return [{ value: "", label: "Unsupported by engine" }];
}

/**
 * Resolve the safe default option for a capability. Used by the
 * chat composer when initializing the pick, and by the runtime as
 * the fallback when the user's saved pick is no longer valid.
 *
 * Priority:
 *   1. The capability's explicit `defaultOption` / `defaultMode`.
 *   2. The first option / mode in the capability's options list.
 *   3. `null` — there is no safe default (unknown / unsupported /
 *      no options).
 */
export function resolveDefaultReasoningOption(capability: ReasoningCapability): string | null {
  if (capability.kind === "effort_levels") {
    if (capability.control === "unknown") return null;
    if (
      capability.defaultOption &&
      capability.options.some((o) => o.value === capability.defaultOption)
    ) {
      return capability.defaultOption;
    }
    return capability.options[0]?.value ?? null;
  }
  if (capability.kind === "thinking_budget") {
    if (capability.control === "unknown") return null;
    if (capability.modes && capability.modes.length > 0) {
      if (
        capability.defaultMode &&
        capability.modes.some((m) => m.value === capability.defaultMode)
      ) {
        return capability.defaultMode;
      }
      return capability.modes[0]?.value ?? null;
    }
    // No modes advertised — fall back to a small set of well-known
    // provider-native mode values when the capability says we
    // support an `enabled` toggle.
    if (capability.supportsEnabled) return "enabled";
    return null;
  }
  return null;
}

/**
 * Test whether a saved option value is still valid for a capability.
 * Returns `true` when the value matches one of the capability's
 * provider-native option values (or, for `thinking_budget` with
 * `supportsEnabled`, when the value is `"enabled"` or `"disabled"`).
 *
 * Stale values (option no longer present after a refresh) must be
 * rejected by access-control and surfaced as a UI warning.
 */
export function isReasoningOptionValid(
  capability: ReasoningCapability,
  value: string | null | undefined,
): boolean {
  if (!value) return false;
  if (capability.kind === "effort_levels") {
    if (capability.control === "unknown") return false;
    return capability.options.some((o) => o.value === value);
  }
  if (capability.kind === "thinking_budget") {
    if (capability.control === "unknown") return false;
    if (capability.modes && capability.modes.some((m) => m.value === value)) {
      return true;
    }
    if (capability.supportsEnabled && (value === "enabled" || value === "disabled")) {
      return true;
    }
    return false;
  }
  return false;
}

/**
 * Short human-readable label for the reasoning capability kind, used
 * by the registry table and the chat composer tooltip. Keep these
 * short — they are tooltips and pill labels.
 */
export function describeReasoningCapability(capability: ReasoningCapability): string {
  switch (capability.kind) {
    case "effort_levels": {
      if (capability.control === "model_dependent") return "Reasoning effort (model-dependent)";
      if (capability.control === "unknown") return "Reasoning effort (unknown)";
      return "Reasoning effort";
    }
    case "thinking_budget":
      return capability.control === "supported"
        ? "Thinking budget"
        : capability.control === "model_dependent"
          ? "Thinking budget (model-dependent)"
          : "Thinking budget (unknown)";
    case "none":
      return "Reasoning not supported";
    case "unknown":
      return "Reasoning capability unknown";
  }
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const UNKNOWN_REASONING_CAPABILITY: UnknownReasoningCapability = Object.freeze({
  kind: "unknown",
  control: "unknown",
});

export const NO_REASONING_CAPABILITY: NoReasoningCapability = Object.freeze({
  kind: "none",
  control: "unsupported",
});

/**
 * Build an `effort_levels` capability from a list of provider-native
 * option values. The convenience helper accepts plain strings (e.g.
 * `["none", "minimal", "low", "medium", "high", "xhigh"]`) and wraps
 * each in a `ReasoningOption` with no label / description. Callers
 * that need labels or descriptions should build the options array
 * by hand.
 */
export function effortLevelsCapability(
  values: ReadonlyArray<string>,
  control: "supported" | "model_dependent" | "unknown" = "supported",
  options: {
    defaultOption?: string;
    source?: ReasoningCapabilitySource;
    refreshedAt?: string;
  } = {},
): EffortLevelsCapability {
  const opts: ReasoningOption[] = values.map((v) => ({ value: v }));
  const out: EffortLevelsCapability = {
    kind: "effort_levels",
    control,
    options: opts,
  };
  if (options.defaultOption !== undefined) out.defaultOption = options.defaultOption;
  if (options.source !== undefined) out.source = options.source;
  if (options.refreshedAt !== undefined) out.refreshedAt = options.refreshedAt;
  return out;
}

export function thinkingBudgetCapability(
  control: "supported" | "model_dependent" | "unknown",
  options: {
    modes?: ReadonlyArray<string> | ReadonlyArray<ReasoningOption>;
    defaultMode?: string;
    supportsEnabled?: boolean;
    supportsTokenBudget?: boolean;
    supportsExclude?: boolean;
    source?: ReasoningCapabilitySource;
    refreshedAt?: string;
    description?: string;
  } = {},
): ThinkingBudgetCapability {
  const out: ThinkingBudgetCapability = {
    kind: "thinking_budget",
    control,
  };
  if (options.modes !== undefined) {
    out.modes = options.modes.map((m) => (typeof m === "string" ? { value: m } : m));
  }
  if (options.defaultMode !== undefined) out.defaultMode = options.defaultMode;
  if (options.supportsEnabled !== undefined) out.supportsEnabled = options.supportsEnabled;
  if (options.supportsTokenBudget !== undefined)
    out.supportsTokenBudget = options.supportsTokenBudget;
  if (options.supportsExclude !== undefined) out.supportsExclude = options.supportsExclude;
  if (options.source !== undefined) out.source = options.source;
  if (options.refreshedAt !== undefined) out.refreshedAt = options.refreshedAt;
  return out;
}

/**
 * Construct a `none` capability with an optional human-readable reason
 * surfaced in the UI as a tooltip / inline note.
 */
export function noReasoningCapability(reason?: string): NoReasoningCapability {
  if (reason === undefined) return { kind: "none", control: "unsupported" };
  return { kind: "none", control: "unsupported", reason };
}

/**
 * Construct an `unknown` capability with an optional human-readable
 * reason (e.g. "discovered-only model — capability not in static catalog").
 */
export function unknownReasoningCapability(reason?: string): UnknownReasoningCapability {
  if (reason === undefined) return { kind: "unknown", control: "unknown" };
  return { kind: "unknown", control: "unknown", reason };
}

/**
 * Convenience: the well-known provider-native option set for
 * `reasoning_effort` style controls on OpenAI / Codex models that
 * support the full `none | minimal | low | medium | high | xhigh`
 * range. Used by the chat composer as the conservative default
 * surface when a Codex or OpenAI model does not yet advertise its
 * specific option set via a provider refresh.
 */
export const FULL_REASONING_EFFORT_VALUES: ReadonlyArray<string> = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

/**
 * Convenience: the well-known OpenAI / Codex cheap-tier option set
 * (no `xhigh`). Used by `gpt-5.4-mini` and similar models that do
 * not advertise an `xhigh` level.
 */
export const CHEAP_TIER_REASONING_EFFORT_VALUES: ReadonlyArray<string> = [
  "none",
  "low",
  "medium",
  "high",
];

/**
 * Convenience: the provider-native thinking modes we currently know
 * MiniMax M3 accepts. Real MiniMax provider refresh may extend this
 * list — see `lib/providers/reasoning-refresh.ts` for the refresh
 * path.
 */
export const MINIMAX_THINKING_MODE_VALUES: ReadonlyArray<string> = [
  "provider_default",
  "adaptive",
  "enabled",
  "disabled",
];

/**
 * Re-export the legacy `ReasoningLevel` set as a constant for callers
 * that need to validate a value against the narrow OpenAI
 * low/medium/high subset (the recommender picker is one such
 * caller). The capability model itself does NOT narrow to this
 * subset.
 */
export const OPENAI_STANDARD_REASONING_LEVELS: ReadonlyArray<ReasoningLevel> = [
  "low",
  "medium",
  "high",
];
