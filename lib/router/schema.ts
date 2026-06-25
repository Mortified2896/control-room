/**
 * Router settings — typed, validated, env-overridable.
 *
 * These are the runtime knobs that govern how the LangGraph router decides
 * Side B and how the safety/budget guards evaluate its output. There is no
 * settings UI in MVP; this module is the single source of truth and any UI
 * will be layered on top of it later (see `docs/POSTGRES_PLAN.md`).
 *
 * Sources of truth, in priority order:
 *   1. `CONTROL_ROOM_ROUTER_SETTINGS` env var (JSON).
 *   2. Built-in `DEFAULT_ROUTER_SETTINGS` below.
 *
 * Validation lives in `parseRouterSettings` (pure, throws on invalid input).
 * `getRouterSettings()` is the safe runtime accessor used by the chat route
 * and the router graph. It never throws: an invalid env var is logged and
 * the defaults are returned.
 *
 * Important: this file must be safe to import from both client and server
 * code. It only depends on `lib/providers` (which is also dependency-free)
 * and on Node's `process.env` accessor, which is fine at build time even in
 * a client bundle — Next inlines `process.env.X` reads for the client.
 */
import { DEFAULT_REASONING_LEVEL } from "@/lib/providers/openai";
import type { ReasoningLevel } from "@/lib/providers/types";

export type RouterSettings = {
  /** Master kill-switch. When false, the router never runs and Side B is skipped. */
  abEnabled: boolean;
  /** When false, expensive-tier models are excluded from the router allowlist. */
  allowExpensiveModels: boolean;
  /**
   * When false, expensive-tier models are also excluded automatically once
   * the prompt crosses `longPromptThresholdChars`. This is the secondary
   * safety net that the brief calls out.
   */
  allowLongPromptWhenExpensive: boolean;
  /** Character count past which we treat the prompt as "long" for safety. */
  longPromptThresholdChars: number;
  /** If the router call itself would cost more than this, fall back. */
  maxCostPerRecommendationUsd: number;
  /** If Side A + Side B combined would cost more than this, skip Side B. */
  maxCostPerAbRunUsd: number;
  /** Model id the router uses for its own recommendation call. */
  routerModelId: string;
  /** Model id used when the router fails or returns a disallowed value. */
  fallbackModelId: string;
  /** Reasoning level used when the router fails or returns a disallowed value. */
  fallbackReasoningLevel: ReasoningLevel;
};

export const DEFAULT_ROUTER_SETTINGS: RouterSettings = {
  abEnabled: true,
  allowExpensiveModels: false,
  allowLongPromptWhenExpensive: false,
  longPromptThresholdChars: 1500,
  maxCostPerRecommendationUsd: 0.03,
  maxCostPerAbRunUsd: 0.3,
  routerModelId: "gpt-5.4-mini",
  fallbackModelId: "gpt-5.4-mini",
  fallbackReasoningLevel: DEFAULT_REASONING_LEVEL,
};

const REASONING_LEVELS: ReadonlyArray<ReasoningLevel> = ["low", "medium", "high"];

function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && (REASONING_LEVELS as ReadonlyArray<string>).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a candidate settings payload into a validated `RouterSettings`.
 * Throws `Error` on invalid input — callers should catch and fall back to
 * defaults.
 */
export function parseRouterSettings(input: unknown): RouterSettings {
  if (!isPlainObject(input)) {
    throw new Error("settings payload must be a JSON object");
  }
  const out: RouterSettings = { ...DEFAULT_ROUTER_SETTINGS };

  if (input.abEnabled !== undefined) {
    if (typeof input.abEnabled !== "boolean") throw new Error("abEnabled must be boolean");
    out.abEnabled = input.abEnabled;
  }
  if (input.allowExpensiveModels !== undefined) {
    if (typeof input.allowExpensiveModels !== "boolean") {
      throw new Error("allowExpensiveModels must be boolean");
    }
    out.allowExpensiveModels = input.allowExpensiveModels;
  }
  if (input.allowLongPromptWhenExpensive !== undefined) {
    if (typeof input.allowLongPromptWhenExpensive !== "boolean") {
      throw new Error("allowLongPromptWhenExpensive must be boolean");
    }
    out.allowLongPromptWhenExpensive = input.allowLongPromptWhenExpensive;
  }
  if (input.longPromptThresholdChars !== undefined) {
    if (
      typeof input.longPromptThresholdChars !== "number" ||
      !Number.isFinite(input.longPromptThresholdChars) ||
      input.longPromptThresholdChars < 0
    ) {
      throw new Error("longPromptThresholdChars must be a non-negative finite number");
    }
    out.longPromptThresholdChars = input.longPromptThresholdChars;
  }
  if (input.maxCostPerRecommendationUsd !== undefined) {
    if (
      typeof input.maxCostPerRecommendationUsd !== "number" ||
      !Number.isFinite(input.maxCostPerRecommendationUsd) ||
      input.maxCostPerRecommendationUsd < 0
    ) {
      throw new Error("maxCostPerRecommendationUsd must be a non-negative finite number");
    }
    out.maxCostPerRecommendationUsd = input.maxCostPerRecommendationUsd;
  }
  if (input.maxCostPerAbRunUsd !== undefined) {
    if (
      typeof input.maxCostPerAbRunUsd !== "number" ||
      !Number.isFinite(input.maxCostPerAbRunUsd) ||
      input.maxCostPerAbRunUsd < 0
    ) {
      throw new Error("maxCostPerAbRunUsd must be a non-negative finite number");
    }
    out.maxCostPerAbRunUsd = input.maxCostPerAbRunUsd;
  }
  if (input.routerModelId !== undefined) {
    if (typeof input.routerModelId !== "string" || input.routerModelId.trim().length === 0) {
      throw new Error("routerModelId must be a non-empty string");
    }
    out.routerModelId = input.routerModelId.trim();
  }
  if (input.fallbackModelId !== undefined) {
    if (typeof input.fallbackModelId !== "string" || input.fallbackModelId.trim().length === 0) {
      throw new Error("fallbackModelId must be a non-empty string");
    }
    out.fallbackModelId = input.fallbackModelId.trim();
  }
  if (input.fallbackReasoningLevel !== undefined) {
    if (!isReasoningLevel(input.fallbackReasoningLevel)) {
      throw new Error("fallbackReasoningLevel must be one of 'low' | 'medium' | 'high'");
    }
    out.fallbackReasoningLevel = input.fallbackReasoningLevel;
  }

  return out;
}

/**
 * Serialize a `RouterSettings` back into a JSON payload suitable for the
 * `CONTROL_ROOM_ROUTER_SETTINGS` env var or a future settings UI.
 */
export function serializeRouterSettings(settings: RouterSettings): string {
  return JSON.stringify(settings, null, 0);
}

let cached: RouterSettings | null = null;

/**
 * Resolve the effective `RouterSettings` for this process.
 *
 * Reads `CONTROL_ROOM_ROUTER_SETTINGS` once and caches the parsed result.
 * If the env var is unset, returns defaults. If it is set but invalid,
 * logs the error and returns defaults (so a typo in the env file never
 * breaks chat).
 */
export function getRouterSettings(): RouterSettings {
  if (cached) return cached;
  const raw = process.env.CONTROL_ROOM_ROUTER_SETTINGS?.trim();
  if (!raw) {
    cached = DEFAULT_ROUTER_SETTINGS;
    return cached;
  }
  try {
    const parsed = parseRouterSettings(JSON.parse(raw));
    cached = parsed;
    return cached;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[router/settings] invalid CONTROL_ROOM_ROUTER_SETTINGS, using defaults:",
      err instanceof Error ? err.message : err,
    );
    cached = DEFAULT_ROUTER_SETTINGS;
    return cached;
  }
}

/**
 * Test-only: reset the in-process cache so a test can mutate the env and
 * re-read. Never call from production code.
 */
export function __resetRouterSettingsCacheForTests(): void {
  cached = null;
}
