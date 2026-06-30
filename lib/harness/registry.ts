import "server-only";

/**
 * Generic coding harness registry.
 *
 * Each "harness" is a server-side agent that can execute a coding task
 * against an active project folder. The registry is the single source of
 * truth for:
 *
 *   - the list of supported harnesses (`codex_cli`, `minimax_cli`, …),
 *   - the labels used everywhere in the UI / logs / docs,
 *   - the model + reasoning metadata that is REQUIRED before the harness
 *     can be selected for a run,
 *   - the runtime availability probe (CLI installed, CLI authenticated).
 *
 * New harnesses are added by:
 *
 *   1. extending `HarnessId`,
 *   2. appending a row to `HARNESS_REGISTRY`,
 *   3. implementing `run<Harness>Run(...)` (and any helper preflight),
 *   4. wiring the dispatcher in `lib/harness/dispatcher.ts`.
 *
 * The router (`/api/router/decision`) consults `HARNESS_REGISTRY` to
 * pick a `recommended_harness` AFTER the first decision gate is
 * approved or corrected to `coding_task`. The chat composer reads the
 * same registry to render a generic harness approval card.
 *
 * Hard rules (from AGENTS.md + the harness extension brief):
 *
 *   - Harnesses are NEVER silently substituted — Codex quota exhaustion
 *     cannot fall back to MiniMax without an explicit user click on the
 *     "Use <other harness> instead" button.
 *   - The registry never calls into a provider directly; the harness
 *     itself owns the CLI subprocess + the provider auth state.
 *   - `requiresProjectFolder: true` is the default; any harness that
 *     operates against arbitrary cwd MUST opt out explicitly.
 */

export type HarnessId = "codex_cli" | "minimax_cli";

/**
 * Coarse availability bucket for a harness. Surfaced both in the registry
 * snapshot AND in the per-run approval card so the user can see why a
 * harness cannot run.
 *
 *   - `available`     — CLI installed, authenticated, quota OK.
 *   - `unavailable`   — CLI missing, not authenticated, or quota
 *                       exhausted. Pair with `unavailableReason`.
 *   - `unknown`       — we have not yet probed this harness on this
 *                       server. Treat as "do not auto-route" but allow
 *                       the user to click the harness button so the
 *                       dispatcher can run a real preflight.
 */
export type HarnessStatus = "available" | "unavailable" | "unknown";

export type HarnessRegistryEntry = {
  /**
   * Stable, kebab-cased harness id. Used as the discriminator on
   * `recommended_harness`, `selected_harness`, the dispatcher
   * `harnessId` argument, and the `threads.harness` CHECK constraint.
   * NEVER rename without a database migration.
   */
  id: HarnessId;
  /** Human-readable label for buttons and headers (e.g. "Codex CLI"). */
  displayName: string;
  /**
   * One-line description of how this harness authenticates and is
   * billed. Used in the approval card AND in the agent-backends
   * settings page. Format: "<executor> / <auth path>" so it is
   * unmistakable what subscription / token plan the user is paying
   * for. Examples:
   *
   *   - "Codex CLI / ChatGPT login"  → Codex CLI, ChatGPT subscription.
   *   - "MiniMax CLI / MiniMax token plan" → MiniMax CLI, MiniMax
   *     token plan (NOT an OpenAI / Codex fallback).
   */
  providerPath: string;
  /**
   * Free-form billing description for analytics + UI. Examples:
   *   - "ChatGPT subscription"
   *   - "MiniMax token plan"
   */
  billingPath: string;
  /**
   * `true` means the harness MUST be invoked against the active
   * project folder (a real working tree). The chat composer disables
   * the harness send button when there is no project selected and
   * the dispatcher refuses to start a run without a resolved cwd.
   */
  requiresProjectFolder: boolean;
  /**
   * `true` means the harness may modify files inside the project
   * folder. Today every supported harness can; the field exists so
   * that future read-only review harnesses can opt out and the UI
   * can render a "this will only read files" hint.
   */
  canModifyFiles: boolean;
  /**
   * Whether the CLI exposes structured token usage in a parseable
   * shape we can surface in the answer metadata. Codex CLI today
   * returns a "tokens used" footer that we deliberately do NOT
   * parse (it's not stable across versions); MiniMax CLI similarly
   * does not yet expose token counts. Both default to `false`.
   *
   * When `false`, the dispatcher must return `tokenUsage: null`
   * rather than faking a count.
   */
  supportsTokenUsage: boolean;
  /**
   * Whether the harness's chat-mode harness (or CLI flags) accepts a
   * provider-native reasoning-effort value (`"low"`, `"medium"`,
   * `"xhigh"`, `"adaptive"`, …). Codex CLI supports `reasoning_effort`
   * on its exec path; MiniMax CLI exposes its own thinking modes
   * (mapped to the existing MiniMax M3 thinking-budget capability) but
   * does not currently accept an `adaptive` / `high` style knob on the
   * CLI surface. We default to `false` for MiniMax so the approval
   * card shows "provider default" rather than a fake picker.
   */
  supportsReasoningLevels: boolean;
  /** Default model id used when no explicit model id was selected. */
  defaultModelId: string;
  /**
   * Model ids the harness is allowed to run against. The registry
   * filters `lib/providers/registry.ts` results by this list so the
   * chat composer / router can never recommend a model the harness
   * does not actually support.
   *
   * Examples:
   *   - Codex CLI  → `["gpt-5.4-mini", "gpt-5.4", "gpt-5.5", "gpt-5.3-codex-spark"]`
   *   - MiniMax CLI → `["MiniMax-M3"]`
   *
   * The model must ALSO carry `supported_execution_targets` on the
   * `EffectiveModelEntry` to be eligible — this list is a hard
   * guard, not a derivation.
   */
  allowedModelIds: ReadonlyArray<string>;
  /**
   * Reasoning / thinking level default for this harness. Used in the
   * approval card when `supportsReasoningLevels === false` so the
   * card can render "provider default" instead of a level value
   * the harness won't actually pass to the provider.
   */
  defaultReasoningLevel: string;
  /**
   * Live status, populated by `probeHarnessStatuses` from the
   * harness-specific status probes (`lib/codex/status.ts`,
   * `lib/minimax/status.ts`). Defaults to `"unknown"` at module
   * load time and is refreshed by callers that need an accurate
   * picture (the agent-backends settings page, the router decision
   * endpoint, and the chat composer when opening a coding task).
   */
  status: HarnessStatus;
  /**
   * Short human-readable reason describing why the harness is
   * `unavailable`. Populated by the status probe. Always `null`
   * when `status !== "unavailable"`.
   */
  unavailableReason: string | null;
};

/**
 * Static registry. The `status` + `unavailableReason` fields are
 * refreshed by `probeHarnessStatuses()`; everything else is immutable
 * per build.
 *
 * The harness order in this list defines the UI preference order:
 * Codex CLI first (subscription, well-known), MiniMax CLI second
 * (token plan, fallback when Codex is unavailable).
 */
export const HARNESS_REGISTRY: ReadonlyArray<HarnessRegistryEntry> = [
  {
    id: "codex_cli",
    displayName: "Codex CLI",
    providerPath: "Codex CLI / ChatGPT login",
    billingPath: "ChatGPT subscription",
    requiresProjectFolder: true,
    canModifyFiles: true,
    supportsTokenUsage: false,
    supportsReasoningLevels: true,
    defaultModelId: "codex:gpt-5.4-mini",
    allowedModelIds: ["gpt-5.4-mini", "gpt-5.4", "gpt-5.5", "gpt-5.3-codex-spark"],
    defaultReasoningLevel: "low",
    status: "unknown",
    unavailableReason: null,
  },
  {
    id: "minimax_cli",
    displayName: "MiniMax CLI",
    providerPath: "MiniMax CLI / MiniMax token plan",
    billingPath: "MiniMax token plan",
    requiresProjectFolder: true,
    canModifyFiles: true,
    supportsTokenUsage: false,
    supportsReasoningLevels: false,
    defaultModelId: "minimax:MiniMax-M3",
    allowedModelIds: ["MiniMax-M3"],
    defaultReasoningLevel: "provider_default",
    status: "unknown",
    unavailableReason: null,
  },
] as const;

export function getHarnessEntry(id: HarnessId): HarnessRegistryEntry {
  const entry = HARNESS_REGISTRY.find((h) => h.id === id);
  if (!entry) throw new Error(`Unknown harness id: ${id}`);
  return entry;
}

export function getHarnessEntryOrNull(id: string | null | undefined): HarnessRegistryEntry | null {
  if (!id) return null;
  return HARNESS_REGISTRY.find((h) => h.id === id) ?? null;
}

/** True if the model id is in the harness's `allowedModelIds` list. */
export function harnessSupportsModel(harness: HarnessRegistryEntry, modelId: string): boolean {
  return harness.allowedModelIds.includes(modelId);
}

/**
 * Resolve a `codex:<id>` / `minimax:<id>` model id to the harness
 * catalog id (the bare codex catalog id or the bare MiniMax id). The
 * bare id is what the harness runner actually passes to its CLI.
 */
export function stripHarnessModelPrefix(modelId: string): string {
  if (modelId.startsWith("codex:")) return modelId.slice("codex:".length);
  if (modelId.startsWith("minimax:")) return modelId.slice("minimax:".length);
  return modelId;
}

/**
 * Per-harness status snapshot returned by `probeHarnessStatuses`.
 * Reflects whether the CLI is installed + authenticated + within quota.
 */
export type HarnessStatusSnapshot = {
  id: HarnessId;
  status: HarnessStatus;
  unavailableReason: string | null;
  /** ISO timestamp of the probe. */
  checkedAt: string;
  /**
   * Harness-specific extras. Codex surfaces a `binary` field
   * (path / version / resolved-from); MiniMax surfaces a
   * `binary` + `region`. Kept opaque here so the harness extension
   * does not need to coordinate type unions.
   */
  extras?: Record<string, unknown>;
};

/**
 * Probe every harness in the registry in parallel. The harness-specific
 * status modules live next to their runners (`lib/codex/status.ts`,
 * `lib/minimax/status.ts`) and each implements `probeXxxStatus`.
 *
 * Failures in any one probe are isolated — the corresponding snapshot
 * keeps `status: "unknown"` and `unavailableReason: "<probe failed>"`.
 */
export async function probeHarnessStatuses(): Promise<ReadonlyArray<HarnessStatusSnapshot>> {
  const probes: Array<Promise<HarnessStatusSnapshot>> = [];

  for (const entry of HARNESS_REGISTRY) {
    if (entry.id === "codex_cli") {
      probes.push(
        (async () => {
          const checkedAt = new Date().toISOString();
          try {
            const { probeCodexStatus } = await import("@/lib/codex/status");
            const dto = await probeCodexStatus();
            return {
              id: entry.id,
              status: codexDtoToStatus(dto),
              unavailableReason: codexDtoToReason(dto),
              checkedAt,
              extras: {
                binary: dto.binary,
                auth: dto.auth,
                usingSubscription: dto.usingSubscription,
              },
            } satisfies HarnessStatusSnapshot;
          } catch (err) {
            return {
              id: entry.id,
              status: "unknown" as const,
              unavailableReason: err instanceof Error ? err.message : "probe failed",
              checkedAt,
            };
          }
        })(),
      );
    } else if (entry.id === "minimax_cli") {
      probes.push(
        (async () => {
          const checkedAt = new Date().toISOString();
          try {
            const { probeMiniMaxStatus } = await import("@/lib/minimax/status");
            const dto = await probeMiniMaxStatus();
            return {
              id: entry.id,
              status: minimaxDtoToStatus(dto),
              unavailableReason: minimaxDtoToReason(dto),
              checkedAt,
              extras: { binary: dto.binary, region: dto.region, authenticated: dto.authenticated },
            } satisfies HarnessStatusSnapshot;
          } catch (err) {
            return {
              id: entry.id,
              status: "unknown" as const,
              unavailableReason: err instanceof Error ? err.message : "probe failed",
              checkedAt,
            };
          }
        })(),
      );
    }
  }

  const settled = await Promise.all(probes);
  // Apply the snapshots back to a fresh in-memory registry so callers
  // that read `HARNESS_REGISTRY` synchronously see the latest probe
  // results. We do NOT mutate the exported `HARNESS_REGISTRY` array —
  // we return the new entry set below.
  return settled;
}

/**
 * Build a fresh registry view with the given snapshots merged in.
 * Pure / deterministic: same snapshots → same registry view.
 */
export function registryWithStatus(
  snapshots: ReadonlyArray<HarnessStatusSnapshot>,
): ReadonlyArray<HarnessRegistryEntry> {
  const byId = new Map(snapshots.map((s) => [s.id, s] as const));
  return HARNESS_REGISTRY.map((entry) => {
    const snap = byId.get(entry.id);
    if (!snap) return entry;
    return {
      ...entry,
      status: snap.status,
      unavailableReason: snap.unavailableReason,
    } satisfies HarnessRegistryEntry;
  });
}

function codexDtoToStatus(dto: { status: string }): HarnessStatus {
  if (dto.status === "logged_in") return "available";
  if (dto.status === "not_installed" || dto.status === "not_logged_in") return "unavailable";
  return "unknown";
}

function codexDtoToReason(dto: { status: string; errorMessage?: string | null }): string | null {
  if (dto.status === "logged_in") return null;
  if (dto.status === "not_installed")
    return "Codex CLI is not installed. Install with: npm install -g @openai/codex";
  if (dto.status === "not_logged_in")
    return "Codex CLI is not logged in. Run: codex login --device-auth";
  return dto.errorMessage ?? "Codex CLI is in an unknown state.";
}

function minimaxDtoToStatus(dto: { status: string }): HarnessStatus {
  if (dto.status === "logged_in") return "available";
  if (dto.status === "not_installed" || dto.status === "not_authenticated") return "unavailable";
  return "unknown";
}

function minimaxDtoToReason(dto: { status: string; errorMessage?: string | null }): string | null {
  if (dto.status === "logged_in") return null;
  if (dto.status === "not_installed")
    return "MiniMax CLI is not installed. Install with: npm install -g mmx-cli";
  if (dto.status === "not_authenticated")
    return "MiniMax CLI is installed but not authenticated. Run: mmx auth login --api-key <MINIMAX_API_KEY>";
  return dto.errorMessage ?? "MiniMax CLI is in an unknown state.";
}
