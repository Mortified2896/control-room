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
   *   - Codex CLI  → `["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"]`
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
    defaultModelId: "codex:gpt-5.5",
    allowedModelIds: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"],
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
 * String-id overload of `harnessSupportsModel`. Resolves the harness
 * entry by id and falls back to `false` when the id is unknown
 * (OpenCode / Pi until they have a registry entry). The
 * compatibility resolver (`lib/harness/compatibility.ts`) consults
 * this overload so callers do not need to thread entries through
 * every helper.
 */
export function harnessSupportsModelById(
  harnessId: HarnessId | string,
  modelId: string,
): boolean {
  const harness = HARNESS_REGISTRY.find((h) => h.id === harnessId);
  if (!harness) return false;
  // Allow either prefixed (`codex:gpt-5.4-mini`) or bare
  // (`gpt-5.4-mini`) ids to resolve.
  return (
    harness.allowedModelIds.includes(modelId) ||
    harness.allowedModelIds.includes(stripHarnessModelPrefix(modelId))
  );
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
   * Optional coarse failure classification, set when the snapshot is
   * downgraded because of a recent in-process run failure. Lets the
   * UI distinguish "Codex token limit exhausted" from a generic
   * "not logged in" probe result. Always `null` for harnesses that
   * are healthy.
   */
  failureKind?: HarnessFailureKind | null;
  /**
   * Harness-specific extras. Codex surfaces a `binary` field
   * (path / version / resolved-from); MiniMax surfaces a
   * `binary` + `region`. Kept opaque here so the harness extension
   * does not need to coordinate type unions.
   */
  extras?: Record<string, unknown>;
  /** Harness usage/quota summary. Null when the provider exposes no safe API. */
  usage?: unknown;
};

/**
 * Closed set of failure kinds the dispatcher records. The UI uses
 * these verbatim so the harness recommendation can prefer
 * alternates without re-classifying raw stderr.
 *
 *   - `usage_limit` — Codex CLI hit "you've hit your usage limit" /
 *     MiniMax CLI hit "token plan exhausted". The harness is
 *     technically installed and authenticated but cannot run new
 *     requests until the limit resets.
 *   - `rate_limit`  — Codex / MiniMax emitted a 429. Distinct from
 *     `usage_limit` because rate-limit windows are short.
 *   - `auth`        — Codex / MiniMax rejected auth mid-run (token
 *     rotated, expired key, etc.). Distinct from "not logged in"
 *     because the user was logged in until just now.
 *   - `internal`    — anything else (process crash, network, etc.).
 *     Recorded so the UI can show "last run failed" without
 *     misclassifying a fresh login problem as quota exhaustion.
 */
export type HarnessFailureKind = "usage_limit" | "rate_limit" | "auth" | "internal";

/**
 * Per-harness recent-failure record. Stored in-process in
 * `lastFailures` and consulted by `probeHarnessStatuses` to
 * downgrade `status` when the CLI is installed + logged in but
 * the last run failed for a recoverable reason.
 *
 * The `freshUntil` timestamp is computed as
 * `failedAt + HARNESS_FAILURE_FRESH_WINDOW_MS`. Failures older
 * than the window are treated as stale and ignored so a successful
 * login-after-failure path does not get permanently downgraded.
 */
export type HarnessFailureRecord = {
  id: HarnessId;
  /** ISO timestamp of the failure. */
  failedAt: string;
  /** Closed-set discriminator — see `HarnessFailureKind`. */
  kind: HarnessFailureKind;
  /** Sanitized, user-facing reason (no API keys / bearer tokens). */
  reason: string;
  /** ISO timestamp at which this record expires. */
  freshUntil: string;
};

/**
 * Window during which a recorded failure is considered "fresh"
 * enough to override the harness's CLI-probe status. Default is
 * one hour — long enough to keep `usage_limit` sticky across
 * several rounds (Codex does not reset its quota in seconds), but
 * short enough that a fresh login the next morning still flips
 * the harness back to `available`.
 */
export const HARNESS_FAILURE_FRESH_WINDOW_MS = 60 * 60 * 1000;

/**
 * Per-harness reason phrasing for the failure kinds. Surfaced
 * verbatim in `unavailableReason` so the harness approval card
 * can show "Codex token limit exhausted" instead of a generic
 * "last run failed". The harness-specific entries come first so
 * the user sees which subscription / token plan is exhausted;
 * the harness-agnostic entry is a generic fallback used when
 * the harness does not have a custom reason.
 */
const FAILURE_REASON_BY_HARNESS: Record<
  HarnessId,
  Record<HarnessFailureKind, string>
> = {
  codex_cli: {
    usage_limit: "Codex token limit exhausted",
    rate_limit: "Codex rate limited",
    auth: "Codex auth rejected on last run",
    internal: "Codex run failed",
  },
  minimax_cli: {
    usage_limit: "MiniMax token plan exhausted",
    rate_limit: "MiniMax rate limited",
    auth: "MiniMax auth rejected on last run",
    internal: "MiniMax run failed",
  },
};

/**
 * In-memory per-harness failure cache. Cleared when a subsequent
 * run succeeds or when the freshness window elapses. Reads /
 * writes are guarded by a `Map` which is single-threaded in
 * Node.js — no need for an explicit mutex.
 */
const lastFailures = new Map<HarnessId, HarnessFailureRecord>();

/**
 * Record a fresh harness failure. Called by the dispatcher when
 * a run completes with a classified error. The new record
 * overwrites any previous record for the same harness so the
 * status probe sees only the most recent failure.
 */
export function recordHarnessFailure(args: {
  id: HarnessId;
  kind: HarnessFailureKind;
  reason: string;
}): HarnessFailureRecord {
  const failedAt = new Date();
  const freshUntil = new Date(failedAt.getTime() + HARNESS_FAILURE_FRESH_WINDOW_MS);
  const record: HarnessFailureRecord = {
    id: args.id,
    failedAt: failedAt.toISOString(),
    kind: args.kind,
    reason: args.reason,
    freshUntil: freshUntil.toISOString(),
  };
  lastFailures.set(args.id, record);
  return record;
}

/**
 * Drop any stored failure record for the harness. Called by the
 * dispatcher after a successful run so a transient
 * `usage_limit` does not permanently downgrade the harness.
 */
export function clearHarnessFailure(id: HarnessId): void {
  lastFailures.delete(id);
}

/**
 * Look up the most-recent in-window failure record for the
 * harness. Returns `null` when no record exists, when the record
 * is older than the freshness window, or when the harness is
 * untracked.
 */
export function getLastHarnessFailure(id: HarnessId): HarnessFailureRecord | null {
  const record = lastFailures.get(id);
  if (!record) return null;
  if (Date.parse(record.freshUntil) <= Date.now()) {
    lastFailures.delete(id);
    return null;
  }
  return record;
}

/**
 * Test-only helper that resets every recorded failure. Production
 * callers MUST use `clearHarnessFailure` per harness id. This
 * function exists so unit tests can run in isolation without
 * leaking state between cases.
 */
export function __resetHarnessFailuresForTests(): void {
  lastFailures.clear();
}

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
            const { probeCodexUsage } = await import("@/lib/codex/usage");
            const usage = await probeCodexUsage();
            return {
              id: entry.id,
              status: codexDtoToStatus(dto),
              unavailableReason: codexDtoToReason(dto),
              checkedAt,
              usage,
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
            const { probeMiniMaxUsage } = await import("@/lib/minimax/usage");
            const usage = await probeMiniMaxUsage();
            return {
              id: entry.id,
              status: minimaxDtoToStatus(dto),
              unavailableReason: minimaxDtoToReason(dto),
              checkedAt,
              usage,
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

  // After the live CLI probes, fold in any recent in-process
  // failure record. The probe says "logged in" but the last run
  // may have hit a usage_limit / rate_limit / auth failure that
  // the live probe cannot detect — we want the harness to read
  // as `unavailable` for the rest of the freshness window so
  // the harness approval card surfaces "Codex token limit
  // exhausted" instead of recommending Codex as primary.
  const merged = settled.map((snap) => applyFailureOverride(snap));
  // Apply the snapshots back to a fresh in-memory registry so callers
  // that read `HARNESS_REGISTRY` synchronously see the latest probe
  // results. We do NOT mutate the exported `HARNESS_REGISTRY` array —
  // we return the new entry set below.
  return merged;
}

/**
 * If we have a recent failure record for the harness, downgrade
 * a `available` probe snapshot to `unavailable` with the
 * failure-specific reason. Stale records (past the freshness
 * window) are ignored. We only downgrade `available`; we never
 * upgrade an `unavailable` probe result to `available` because
 * the CLI probe is authoritative for login / install state.
 */
function applyFailureOverride(snap: HarnessStatusSnapshot): HarnessStatusSnapshot {
  const failure = getLastHarnessFailure(snap.id);
  if (!failure) return snap;
  // The CLI probe itself reports unavailable — keep its reason,
  // but attach the failure kind so the UI can show the same
  // "last run failed" hint next to the install / login error.
  if (snap.status !== "available") {
    return { ...snap, failureKind: failure.kind };
  }
  const reasonByKind = FAILURE_REASON_BY_HARNESS[snap.id] ?? null;
  const overrideReason = reasonByKind?.[failure.kind] ?? failure.reason;
  return {
    ...snap,
    status: "unavailable",
    unavailableReason: overrideReason,
    failureKind: failure.kind,
  };
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
      // The harness entry carries the failure kind so the UI can
      // tell a quota-exhausted Codex apart from a not-logged-in
      // Codex. We surface it on the entry's `unavailableReason`
      // (which already shows "Codex token limit exhausted") so
      // clients reading the entry by id see the same string.
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
