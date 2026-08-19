import "server-only";

import { withClient, tryDb } from "@/lib/db";

/**
 * Repo functions for the manual model selector visibility preferences.
 *
 * Decoupled from `router_settings.allowedCombos` per the brief: which
 * models appear in the manual chat selector is a separate decision from
 * which (model, reasoning-level) combinations the router may recommend.
 *
 * Shape of the JSONB `preferences` column:
 *   { "<modelId>": { "visible": boolean }, ... }
 *
 * Missing keys are treated as "default" (visible for known+available
 * models, hidden for unknown / stale models). The default-row insert in
 * `0007_model_discovery.sql` seeds the empty object; the runtime default
 * behavior is computed in `lib/providers/registry.ts`.
 *
 * Read paths use `tryDb` so a missing DB degrades to the empty
 * preferences object — the chat UI keeps working. Write paths throw so
 * the Settings UI can surface validation errors clearly.
 */

export const SELECTOR_PREFS_SINGLETON_ID = 1 as const;
export const SELECTOR_PREFS_SCHEMA_VERSION = 1 as const;

export type SelectorPreference = { visible: boolean };

export type SelectorPreferences = Readonly<Record<string, SelectorPreference>>;

export type SelectorPrefsValidationError = { field: string; message: string };

export const EMPTY_SELECTOR_PREFERENCES: SelectorPreferences = Object.freeze({});

type RawPrefsRow = {
  id: number;
  preferences: unknown;
  schema_version: number;
  updated_by: string | null;
  updated_at: Date | null;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePreferences(input: unknown): {
  ok: boolean;
  value: Record<string, SelectorPreference>;
  errors: SelectorPrefsValidationError[];
} {
  const errors: SelectorPrefsValidationError[] = [];
  if (!isPlainObject(input)) {
    return {
      ok: false,
      value: {},
      errors: [{ field: "preferences", message: "preferences must be a JSON object." }],
    };
  }
  const out: Record<string, SelectorPreference> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (typeof key !== "string" || key.trim().length === 0) {
      errors.push({ field: "preferences", message: "model ids must be non-empty strings." });
      continue;
    }
    if (!isPlainObject(raw)) {
      errors.push({
        field: `preferences.${key}`,
        message: `preferences.${key} must be an object.`,
      });
      continue;
    }
    if (typeof raw.visible !== "boolean") {
      errors.push({
        field: `preferences.${key}.visible`,
        message: `preferences.${key}.visible must be a boolean.`,
      });
      continue;
    }
    out[key] = { visible: raw.visible };
  }
  return { ok: errors.length === 0, value: out, errors };
}

/**
 * Read the current selector preferences. Returns the empty object on DB
 * miss / error / parse failure so the chat path always has a usable value.
 */
export async function getSelectorPreferences(): Promise<SelectorPreferences> {
  return tryDb(async (c) => {
    const { rows } = await c.query<RawPrefsRow>(
      `SELECT id, preferences, schema_version, updated_by, updated_at
         FROM model_selector_prefs
        WHERE id = $1`,
      [SELECTOR_PREFS_SINGLETON_ID],
    );
    const row = rows[0];
    if (!row) return EMPTY_SELECTOR_PREFERENCES;
    if (!isPlainObject(row.preferences)) return EMPTY_SELECTOR_PREFERENCES;
    const parsed = validatePreferences(row.preferences);
    if (!parsed.ok) {
      // eslint-disable-next-line no-console
      console.error(
        "[repo/model-selector-prefs] persisted prefs failed validation, returning empty:",
        parsed.errors,
      );
      return EMPTY_SELECTOR_PREFERENCES;
    }
    return Object.freeze(parsed.value) as SelectorPreferences;
  }, EMPTY_SELECTOR_PREFERENCES);
}

/**
 * Replace the singleton preferences row. Validates the payload before
 * touching the DB and returns the validation result so the HTTP layer can
 * render per-field errors.
 *
 * Throws on DB error after validation passes (the caller catches).
 */
export async function setSelectorPreferences(input: {
  preferences: unknown;
  updatedBy?: string | null;
}): Promise<
  | { ok: true; value: SelectorPreferences }
  | { ok: false; errors: ReadonlyArray<SelectorPrefsValidationError> }
> {
  const parsed = validatePreferences(input.preferences);
  if (!parsed.ok) {
    return { ok: false, errors: parsed.errors };
  }
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO model_selector_prefs (id, preferences, schema_version, updated_by)
       VALUES ($1, $2::jsonb, $3, $4)
       ON CONFLICT (id) DO UPDATE
       SET preferences    = EXCLUDED.preferences,
           schema_version = EXCLUDED.schema_version,
           updated_by     = EXCLUDED.updated_by`,
      [
        SELECTOR_PREFS_SINGLETON_ID,
        JSON.stringify(parsed.value),
        SELECTOR_PREFS_SCHEMA_VERSION,
        input.updatedBy ?? null,
      ],
    );
  });
  return { ok: true, value: Object.freeze(parsed.value) as SelectorPreferences };
}

/**
 * Test-only: clear the preferences row back to the empty object. Used
 * by tests that need a clean slate between runs.
 */
export async function __resetSelectorPrefsForTests(): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `UPDATE model_selector_prefs
          SET preferences = '{}'::jsonb
        WHERE id = $1`,
      [SELECTOR_PREFS_SINGLETON_ID],
    );
  });
}
