import "server-only";

import { withClient, withTransaction } from "@/lib/db";
import {
  DEFAULT_ROUTER_SETTINGS,
  parseRouterSettingsForSave,
  type RouterSettings,
} from "@/lib/router/schema";

/**
 * Repo functions for the Router Settings singleton row.
 *
 * Read paths use `withClient` and degrade gracefully when the table does
 * not exist yet (we still expect pre-migration deployments, and the
 * migration runner applies the table before the first read in normal
 * operation). Write paths throw on failure so the HTTP layer can surface
 * the error to the Settings UI.
 *
 * The settings row is a *singleton* (id=1 CHECK constraint) so every
 * `upsertRouterSettings` call replaces the previous payload atomically.
 * We deliberately store the full validated settings as JSONB rather than
 * splitting each field into its own column — the schema is versioned via
 * `schema_version` and the UI round-trips the whole payload at once.
 */

export const ROUTER_SETTINGS_SINGLETON_ID = 1 as const;
export const ROUTER_SETTINGS_CURRENT_SCHEMA_VERSION = 1 as const;

type RawRouterSettings = {
  id: number;
  settings: Record<string, unknown>;
  schema_version: number;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the current persisted Router Settings. Returns `null` if no row has
 * been written yet (the migration inserts an empty default, but defensive
 * callers still want to handle a missing row).
 *
 * Read path deliberately throws on DB error — the Settings UI needs to
 * surface the error to the user, not silently fall back to defaults
 * (otherwise the user could "save" changes that never land).
 */
export async function getRouterSettingsRow(): Promise<RouterSettings | null> {
  return withClient(async (c) => {
    const { rows } = await c.query<RawRouterSettings>(
      "SELECT id, settings, schema_version, updated_by, created_at, updated_at FROM router_settings WHERE id = $1",
      [ROUTER_SETTINGS_SINGLETON_ID],
    );
    const row = rows[0];
    if (!row) return null;
    if (!isPlainObject(row.settings)) return null;
    const result = parseRouterSettingsForSave(row.settings);
    if (!result.ok) {
      // The persisted payload is corrupt (e.g. from an older schema
      // version). Log and fall back to defaults so the UI still loads
      // and the user can re-save valid settings.
      // eslint-disable-next-line no-console
      console.error(
        "[repo/router-settings] persisted settings failed validation, returning defaults:",
        result.errors,
      );
      return DEFAULT_ROUTER_SETTINGS;
    }
    return result.value;
  });
}

/**
 * Upsert the singleton settings row. Validates the payload through the
 * strict save-time parser before touching the DB; returns the validation
 * result on failure so the HTTP layer can render per-field errors.
 */
export async function upsertRouterSettingsRow(input: {
  settings: unknown;
  updatedBy?: string | null;
}): Promise<
  | { ok: true; value: RouterSettings }
  | { ok: false; errors: ReadonlyArray<{ field: string; message: string }> }
> {
  const validation = parseRouterSettingsForSave(input.settings);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }
  await withTransaction(async (c) => {
    await c.query(
      `INSERT INTO router_settings (id, settings, schema_version, updated_by)
       VALUES ($1, $2::jsonb, $3, $4)
       ON CONFLICT (id) DO UPDATE
       SET settings = EXCLUDED.settings,
           schema_version = EXCLUDED.schema_version,
           updated_by = EXCLUDED.updated_by`,
      [
        ROUTER_SETTINGS_SINGLETON_ID,
        JSON.stringify(validation.value),
        ROUTER_SETTINGS_CURRENT_SCHEMA_VERSION,
        input.updatedBy ?? null,
      ],
    );
  });
  return { ok: true, value: validation.value };
}
