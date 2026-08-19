/**
 * Deterministic fake discovery for dev and Playwright.
 *
 * Mirrors the style of `lib/router/fake-llm.ts` — no I/O, no env reads
 * inside the data function (env reads happen in the caller so tests can
 * stub them). Activated by `CONTROL_ROOM_FAKE_OPENAI_MODELS=1` (or
 * implicitly by `CONTROL_ROOM_FAKE_LLM=1`).
 *
 * The fake deliberately includes:
 *   - `gpt-5.4-mini`         — known, cheap tier, reasoning [low, medium]
 *   - `gpt-5.5`              — known, expensive tier, reasoning [low, medium, high]
 *   - `gpt-fake-known-extra` — registered in the static alias map as cheap
 *                              so we can prove the merge handles a 3rd known
 *                              model without writing a real network test.
 *   - `gpt-fake-unknown-xyz` — NOT in the static alias map, so it exercises
 *                              the unknown-discovered-model branch of the
 *                              merge logic. By the brief this must be
 *                              hidden from the manual selector by default
 *                              and must NOT enter the router pool.
 *
 * The list is intentionally small and frozen — Playwright asserts against
 * these exact ids.
 */
export const FAKE_OPENAI_MODEL_IDS: ReadonlyArray<string> = [
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-fake-known-extra",
  "gpt-fake-unknown-xyz",
];

/**
 * Standard extra model id. Registered in `OPENAI_STATIC_ALIASES` so the
 * merge layer treats it as "known" and lets it through manual-selector +
 * router pool once the user opts in.
 */
export const FAKE_KNOWN_EXTRA_MODEL_ID = "gpt-fake-known-extra";

/**
 * Standard unknown fake model id. Not in the static alias map; the merge
 * layer tags it as `known: false` and rejects it from the router pool.
 */
export const FAKE_UNKNOWN_MODEL_ID = "gpt-fake-unknown-xyz";

export function getFakeOpenAIModelIds(): ReadonlyArray<string> {
  return FAKE_OPENAI_MODEL_IDS;
}

/**
 * Activation check for the fake. `CONTROL_ROOM_FAKE_LLM=1` implies
 * `CONTROL_ROOM_FAKE_OPENAI_MODELS=1` so dev / Playwright that opts into
 * the broader fake-LLM mode never has to remember the second flag.
 *
 * The implication is intentional: the brief explicitly allows it ("reuse
 * CONTROL_ROOM_FAKE_LLM=1 if that is cleaner") and Playwright sets both
 * explicitly anyway.
 */
export function isFakeOpenAIModelsEnabled(): boolean {
  if (process.env.CONTROL_ROOM_FAKE_LLM === "1") return true;
  return process.env.CONTROL_ROOM_FAKE_OPENAI_MODELS === "1";
}
