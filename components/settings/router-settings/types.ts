/**
 * Shared DTO types for the split `/settings/router` UI.
 *
 * The fields mirror the `/api/router-settings` response one-for-one so
 * the page component can hydrate each tab without re-parsing. The
 * Settings UI keeps the same shape as the existing single-registry
 * layout; only the visual organization changes (three focused tabs
 * instead of one overloaded table).
 *
 * `EffectiveRegistryModelDto` is duplicated here as a focused type that
 * only owns the columns the new tabs render. We do NOT delete the old
 * type from `components/settings/router-settings-page.tsx` — legacy
 * callers still import it during the migration.
 */

import type { ProviderId } from "@/lib/providers/types";
import type { ReasoningCapability } from "@/lib/providers/capability";

export type SettingsProviderId = "openai" | "minimax" | "codex";

/**
 * Per-model row used by all three tabs. Mirrors the
 * `effectiveRegistry.models[]` entries returned by `/api/router-settings`,
 * narrowed to the columns the new UI exposes.
 *
 * Columns intentionally removed from the main view (per the brief):
 *   - `tier` ("standard" / "expensive" / "unknown")
 *   - `provenance` ("local_meta" / "fake" / "stale" / "env_static")
 *   - `refreshedAt`
 *   - `capabilities.reasoning | vision | images | functionCalling | …`
 *
 * Per-row details (currently disabled placeholders behind `registry-capability-*`
 * test IDs) can be re-introduced later without affecting this DTO.
 */
export type EffectiveRegistryModelDto = {
  providerId: ProviderId | "codex";
  providerLabel: string;
  modelId: string;
  displayLabel: string;
  configured: boolean;
  available: boolean;
  /** When true, this row was in a previous discovery snapshot but not the current one. */
  stale: boolean;
  /** Reasoning / thinking capability (canonical shape — see lib/providers/capability.ts). */
  reasoningCapability: ReasoningCapability;
  /** Provider-native reasoning-effort values when the capability is effort_levels. */
  supportedReasoningLevels: ReadonlyArray<string>;
  /**
   * Coarse billing discriminator. Used by the new tabs to render the
   * "Subscription-backed" / "API-billed" tag at-a-glance, and to drive
   * the bulk-action "Block API-billed models" button in Tab C.
   */
  billingSource: "subscription" | "api_billing";
};
