import "server-only";

import { isDbConfigured } from "@/lib/db";
import { getRouterSettingsRow } from "@/lib/repo/router-settings";
import { DEFAULT_ROUTER_SETTINGS, getRouterSettings, type RouterSettings } from "./schema";

/**
 * Async, DB-overridable settings resolver.
 *
 * Used by the chat route on every A/B request. Order of precedence:
 *
 *   1. The persisted singleton row in `router_settings` (the Settings UI).
 *   2. The `CONTROL_ROOM_ROUTER_SETTINGS` env var (cached in-process).
 *   3. `DEFAULT_ROUTER_SETTINGS`.
 *
 * Behavior:
 *   - When the DB is not configured, returns `getRouterSettings()` (env
 *     or defaults) so chat still works offline.
 *   - When the DB IS configured but the row is missing or corrupt, falls
 *     back to `getRouterSettings()` and logs the issue. We never throw
 *     to the chat path — a transient DB read failure must not break the
 *     user-visible chat.
 *   - When the DB has a valid row, that row's payload replaces the env
 *     defaults wholesale. We do not partial-merge: the Settings UI ships
 *     a complete payload, and the env var is documented as a fallback
 *     for setups without a UI.
 *
 * A short in-process cache (~3 seconds) keeps the chat path cheap while
 * still letting a fresh "Save" in the Settings UI show up in the very
 * next prompt without requiring a server restart. The cache is global to
 * the Next.js node process — this is acceptable for a single-tenant dev
 * app and keeps the chat route simple.
 */

let cache: { settings: RouterSettings; cachedAtMs: number } | null = null;
const CACHE_TTL_MS = 3_000;

export async function getEffectiveRouterSettings(): Promise<RouterSettings> {
  const now = Date.now();
  if (cache && now - cache.cachedAtMs < CACHE_TTL_MS) {
    return cache.settings;
  }
  const settings = await readFreshSettings();
  cache = { settings, cachedAtMs: now };
  return settings;
}

/**
 * Read the latest settings from the DB (or env fallback) and bypass the
 * cache. Called by the Settings UI PUT handler so a "Save" returns the
 * exact payload that landed in Postgres, and by tests that need a clean
 * slate.
 */
export async function reloadEffectiveRouterSettings(): Promise<RouterSettings> {
  cache = null;
  return getEffectiveRouterSettings();
}

async function readFreshSettings(): Promise<RouterSettings> {
  if (!isDbConfigured()) return getRouterSettings();
  try {
    const row = await getRouterSettingsRow();
    if (row) return row;
    // No row yet — fall through to env defaults. The migration inserts
    // an empty JSONB default, so a real "no row" only happens if the
    // table was truncated or the singleton constraint was bypassed.
    return getRouterSettings();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[router/settings-store] DB read failed, falling back to env defaults:",
      err instanceof Error ? err.message : err,
    );
    return getRouterSettings();
  }
}

/**
 * Test-only: clear the in-process cache. Used by tests that mutate the
 * DB singleton between runs and want to assert the chat path re-reads.
 */
export function __resetEffectiveRouterSettingsCacheForTests(): void {
  cache = null;
}

void DEFAULT_ROUTER_SETTINGS;
