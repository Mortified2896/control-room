/**
 * Type-only mirror of `lib/repo/model-selector-prefs.ts`.
 *
 * See `lib/repo/openai-models-discovery-types.ts` for the rationale.
 */

export type SelectorPreference = { visible: boolean };

export type SelectorPreferences = Readonly<Record<string, SelectorPreference>>;

export type SelectorPrefsValidationError = { field: string; message: string };

export const EMPTY_SELECTOR_PREFERENCES: SelectorPreferences = Object.freeze({});
