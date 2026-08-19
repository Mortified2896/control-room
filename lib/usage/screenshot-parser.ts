/**
 * Pure screenshot-extraction helpers for the manual provider-usage flow.
 *
 * Hard rule: this module NEVER calls provider websites, NEVER logs in,
 * NEVER calls OpenAI / MiniMax / Codex APIs, and NEVER touches OCR. It
 * exposes:
 *
 *   1. `detectProviderFromLabels` — a *heuristic* label match on the
 *      uploaded filename + (optional) base64 payload. Heuristic-only;
 *      accuracy depends on what the user dropped and the labels below.
 *
 *   2. `normalizeMiniMaxRemaining` / `normalizeCodexRemaining` — pure
 *      normalizers that derive the missing percent (used ↔ remaining)
 *      and clamp into `[0, 100]`. These are what convert raw
 *      user-entered values into the canonical DTO shape.
 *
 *   3. `parseSnapshotFromForm` — top-level helper used by both
 *      `app/api/usage/screenshot/extract/route.ts` and the repo
 *      tests. It accepts the raw multipart payload + optional
 *      `providerId` + optional `notes`, runs the heuristic, and
 *      returns an `{ ok, value }` result.
 *
 *   4. `buildExtractResult` — composes the full
 *     `/api/usage/screenshot/extract` response object, always with
 *     `extractionMode: "manual_placeholder"` so the UI can render a
 *     clear "you are filling this in by hand" banner.
 */

import {
  ACCESS_TYPES,
  CONFIDENCE_LEVELS,
  EMPTY_CANDIDATE,
  PROVIDER_DISPLAY,
  PROVIDER_IDS,
  ProviderUsageSnapshotSchema,
  SOURCE_TYPES,
  type ConfidenceLevel,
  type ProviderUsageSnapshot,
  type SourceType,
  type ValidationError,
} from "./snapshot-shape";

/** Labels lifted verbatim from the task brief. */
export const MINIMAX_LABELS: ReadonlyArray<string> = [
  "Plan Usage",
  "MiniMax Subscription Plan Usage Details",
  "Token Plan",
  "Monthly Plus",
  "5h limit",
  "Weekly limit",
];

export const CODEX_LABELS: ReadonlyArray<string> = [
  "Balance",
  "Codex usage draws from your shared agentic usage limit",
  "5 hour usage limit",
  "Weekly usage limit",
  "Credits remaining",
];

export type DetectionConfidence = "high" | "low" | "none";
export type DetectedProvider = "minimax" | "codex" | "unknown";

export type LabelHit = { provider: "minimax" | "codex"; label: string };

/**
 * Heuristic label match.
 *
 * `input.base64Content` is accepted but never decoded — we only
 * substring-match against the textual payload (which is what callers
 * typically hand us when OCR is unavailable: a partial OCR transcript
 * or the filename). This is intentionally cheap and tolerant of
 * whatever the UI hands us.
 */
export function detectProviderFromLabels(input: {
  filename: string;
  base64Content?: string | null;
  explicitProviderId?: string | null;
}): {
  detectedProvider: DetectedProvider;
  providerConfidence: DetectionConfidence;
  minimaxHits: number;
  codexHits: number;
  matchedLabels: LabelHit[];
} {
  // Normalize the haystack: lowercase, replace separators with spaces,
  // collapse whitespace. This lets a filename like
  // `minimax-Plan-Usage-5h-limit.png` match the labels "Plan Usage" and
  // "5h limit".
  const rawHaystack = `${input.filename ?? ""}\n${input.base64Content ?? ""}`;
  const haystack = ` ${rawHaystack
    .toLowerCase()
    .replace(/[_\-./]+/g, " ")
    .replace(/\s+/g, " ")} `;
  const labelHaystack = (label: string) =>
    ` ${label
      .toLowerCase()
      .replace(/[_\-./]+/g, " ")
      .replace(/\s+/g, " ")} `;

  const minimaxHits: LabelHit[] = [];
  for (const label of MINIMAX_LABELS) {
    if (haystack.includes(labelHaystack(label))) minimaxHits.push({ provider: "minimax", label });
  }
  const codexHits: LabelHit[] = [];
  for (const label of CODEX_LABELS) {
    if (haystack.includes(labelHaystack(label))) codexHits.push({ provider: "codex", label });
  }

  const matched = [...minimaxHits, ...codexHits];

  let detectedProvider: DetectedProvider;
  let providerConfidence: DetectionConfidence;

  if (minimaxHits.length === 0 && codexHits.length === 0) {
    detectedProvider = "unknown";
    providerConfidence = "none";
  } else if (minimaxHits.length > codexHits.length) {
    detectedProvider = "minimax";
    providerConfidence = minimaxHits.length >= 2 ? "high" : "low";
  } else if (codexHits.length > minimaxHits.length) {
    detectedProvider = "codex";
    providerConfidence = codexHits.length >= 2 ? "high" : "low";
  } else {
    // Tie or both >= 1 — treat as low confidence and let the UI show
    // both possibilities to the user.
    detectedProvider = "unknown";
    providerConfidence = "low";
  }

  if (input.explicitProviderId === "minimax" || input.explicitProviderId === "codex") {
    detectedProvider = input.explicitProviderId;
    // Explicit user choice is always at least "high" from the user's
    // perspective — they're telling us which provider it is.
    providerConfidence = matched.length > 0 ? providerConfidence : "low";
  }

  return {
    detectedProvider,
    providerConfidence,
    minimaxHits: minimaxHits.length,
    codexHits: codexHits.length,
    matchedLabels: matched,
  };
}

function clampPercent(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
}

/**
 * MiniMax screenshot shows used percent. Derive remaining = 100 - used.
 * Existing user-entered remaining values are preserved (the user is
 * the source of truth).
 */
export function normalizeMiniMaxRemaining(input: {
  shortWindowUsedPercent?: number | null;
  shortWindowRemainingPercent?: number | null;
  weeklyWindowUsedPercent?: number | null;
  weeklyWindowRemainingPercent?: number | null;
}): {
  shortWindowUsedPercent: number | null;
  shortWindowRemainingPercent: number | null;
  weeklyWindowUsedPercent: number | null;
  weeklyWindowRemainingPercent: number | null;
} {
  const shortUsed = clampPercent(input.shortWindowUsedPercent);
  const weeklyUsed = clampPercent(input.weeklyWindowUsedPercent);
  return {
    shortWindowUsedPercent: shortUsed,
    shortWindowRemainingPercent:
      input.shortWindowRemainingPercent !== null && input.shortWindowRemainingPercent !== undefined
        ? clampPercent(input.shortWindowRemainingPercent)
        : shortUsed === null
          ? null
          : 100 - shortUsed,
    weeklyWindowUsedPercent: weeklyUsed,
    weeklyWindowRemainingPercent:
      input.weeklyWindowRemainingPercent !== null &&
      input.weeklyWindowRemainingPercent !== undefined
        ? clampPercent(input.weeklyWindowRemainingPercent)
        : weeklyUsed === null
          ? null
          : 100 - weeklyUsed,
  };
}

/**
 * Codex screenshot shows remaining percent. Derive used = 100 - remaining.
 */
export function normalizeCodexRemaining(input: {
  shortWindowRemainingPercent?: number | null;
  shortWindowUsedPercent?: number | null;
  weeklyWindowRemainingPercent?: number | null;
  weeklyWindowUsedPercent?: number | null;
}): {
  shortWindowUsedPercent: number | null;
  shortWindowRemainingPercent: number | null;
  weeklyWindowUsedPercent: number | null;
  weeklyWindowRemainingPercent: number | null;
} {
  const shortRemaining = clampPercent(input.shortWindowRemainingPercent);
  const weeklyRemaining = clampPercent(input.weeklyWindowRemainingPercent);
  return {
    shortWindowRemainingPercent: shortRemaining,
    shortWindowUsedPercent:
      input.shortWindowUsedPercent !== null && input.shortWindowUsedPercent !== undefined
        ? clampPercent(input.shortWindowUsedPercent)
        : shortRemaining === null
          ? null
          : 100 - shortRemaining,
    weeklyWindowRemainingPercent: weeklyRemaining,
    weeklyWindowUsedPercent:
      input.weeklyWindowUsedPercent !== null && input.weeklyWindowUsedPercent !== undefined
        ? clampPercent(input.weeklyWindowUsedPercent)
        : weeklyRemaining === null
          ? null
          : 100 - weeklyRemaining,
  };
}

export type ParseOk = {
  ok: true;
  value: ProviderUsageSnapshot;
  detectedProvider: DetectedProvider;
  providerConfidence: DetectionConfidence;
  matchedLabels: string[];
};

export type ParseErr = {
  ok: false;
  errors: ValidationError[];
};

export function parseSnapshotFromForm(input: {
  filename: string;
  base64Content?: string | null;
  explicitProviderId?: string | null;
  notes?: string | null;
  fields: Record<string, unknown>;
}): ParseOk | ParseErr {
  const detection = detectProviderFromLabels({
    filename: input.filename,
    base64Content: input.base64Content,
    explicitProviderId: input.explicitProviderId,
  });

  const providerId =
    detection.detectedProvider === "unknown"
      ? (PROVIDER_IDS[0] ?? "minimax")
      : detection.detectedProvider;

  const candidate: ProviderUsageSnapshot = {
    ...EMPTY_CANDIDATE,
    providerId,
    providerLabel: PROVIDER_DISPLAY[providerId] ?? "Provider",
    notes: input.notes ?? null,
    capturedAt: new Date().toISOString(),
  };

  // Whitelist: only fields the user explicitly typed into the form are
  // copied across. The whole "we never invent values" rule depends on
  // this.
  const fields = input.fields;
  if (typeof fields.planName === "string") candidate.planName = fields.planName;
  if (typeof fields.shortWindowLabel === "string")
    candidate.shortWindowLabel = fields.shortWindowLabel;
  if (typeof fields.shortWindowResetLabel === "string")
    candidate.shortWindowResetLabel = fields.shortWindowResetLabel;
  if (typeof fields.weeklyWindowLabel === "string")
    candidate.weeklyWindowLabel = fields.weeklyWindowLabel;
  if (typeof fields.weeklyWindowResetLabel === "string")
    candidate.weeklyWindowResetLabel = fields.weeklyWindowResetLabel;
  if (typeof fields.usageAtTimestampValue === "string")
    candidate.usageAtTimestampValue = fields.usageAtTimestampValue;
  if (typeof fields.usageAtTimestampLabel === "string")
    candidate.usageAtTimestampLabel = fields.usageAtTimestampLabel;
  if (typeof fields.last7DaysUsage === "string") candidate.last7DaysUsage = fields.last7DaysUsage;
  if (typeof fields.last30DaysUsage === "string")
    candidate.last30DaysUsage = fields.last30DaysUsage;

  if (typeof fields.creditsRemaining === "number" || fields.creditsRemaining === null) {
    candidate.creditsRemaining =
      typeof fields.creditsRemaining === "number" && Number.isFinite(fields.creditsRemaining)
        ? fields.creditsRemaining
        : null;
  }

  // Normalize percent fields based on the detected provider.
  if (providerId === "minimax") {
    const norm = normalizeMiniMaxRemaining({
      shortWindowUsedPercent: numericOrNull(fields.shortWindowUsedPercent),
      shortWindowRemainingPercent: numericOrNull(fields.shortWindowRemainingPercent),
      weeklyWindowUsedPercent: numericOrNull(fields.weeklyWindowUsedPercent),
      weeklyWindowRemainingPercent: numericOrNull(fields.weeklyWindowRemainingPercent),
    });
    candidate.shortWindowUsedPercent = norm.shortWindowUsedPercent;
    candidate.shortWindowRemainingPercent = norm.shortWindowRemainingPercent;
    candidate.weeklyWindowUsedPercent = norm.weeklyWindowUsedPercent;
    candidate.weeklyWindowRemainingPercent = norm.weeklyWindowRemainingPercent;
  } else {
    const norm = normalizeCodexRemaining({
      shortWindowRemainingPercent: numericOrNull(fields.shortWindowRemainingPercent),
      shortWindowUsedPercent: numericOrNull(fields.shortWindowUsedPercent),
      weeklyWindowRemainingPercent: numericOrNull(fields.weeklyWindowRemainingPercent),
      weeklyWindowUsedPercent: numericOrNull(fields.weeklyWindowUsedPercent),
    });
    candidate.shortWindowUsedPercent = norm.shortWindowUsedPercent;
    candidate.shortWindowRemainingPercent = norm.shortWindowRemainingPercent;
    candidate.weeklyWindowUsedPercent = norm.weeklyWindowUsedPercent;
    candidate.weeklyWindowRemainingPercent = norm.weeklyWindowRemainingPercent;
  }

  // Confidence is only upgraded when the user explicitly typed values
  // for at least one window. Empty forms stay "unknown".
  candidate.confidence = hasAnyWindowValue(candidate) ? "observed" : "unknown";

  const parsed = ProviderUsageSnapshotSchema.safeParse(candidate);
  if (!parsed.success) {
    const errors: ValidationError[] = parsed.error.issues.map((iss) => ({
      path: iss.path.join(".") || "<root>",
      message: iss.message,
    }));
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: parsed.data,
    detectedProvider: detection.detectedProvider,
    providerConfidence: detection.providerConfidence,
    matchedLabels: detection.matchedLabels.map((m) => m.label),
  };
}

function numericOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))
    return Number(value);
  return null;
}

function hasAnyWindowValue(snapshot: ProviderUsageSnapshot): boolean {
  return (
    snapshot.shortWindowUsedPercent !== null ||
    snapshot.shortWindowRemainingPercent !== null ||
    snapshot.weeklyWindowUsedPercent !== null ||
    snapshot.weeklyWindowRemainingPercent !== null ||
    snapshot.creditsRemaining !== null
  );
}

export type ExtractResponse = {
  extractionMode: "manual_placeholder";
  detectedProvider: DetectedProvider;
  providerConfidence: DetectionConfidence;
  matchedLabels: string[];
  requiresUserConfirmation: true;
  candidate: ProviderUsageSnapshot;
};

/**
 * Compose the full `/api/usage/screenshot/extract` response.
 *
 * Always returns `extractionMode: "manual_placeholder"`. Never returns
 * `providerConfidence: "high"` from OCR (heuristics only). The user
 * must still confirm before any values land in the database.
 */
export function buildExtractResult(input: {
  filename: string;
  base64Content?: string | null;
  explicitProviderId?: string | null;
  notes?: string | null;
  fields?: Record<string, unknown>;
}): { ok: true; value: ExtractResponse } | { ok: false; errors: ValidationError[] } {
  const parsed = parseSnapshotFromForm({
    filename: input.filename,
    base64Content: input.base64Content,
    explicitProviderId: input.explicitProviderId,
    notes: input.notes,
    fields: input.fields ?? {},
  });
  if (!parsed.ok) return { ok: false, errors: parsed.errors };

  const response: ExtractResponse = {
    extractionMode: "manual_placeholder",
    detectedProvider: parsed.detectedProvider,
    providerConfidence: parsed.providerConfidence,
    matchedLabels: parsed.matchedLabels,
    requiresUserConfirmation: true,
    candidate: parsed.value,
  };
  return { ok: true, value: response };
}

/**
 * Override helper used by the API layer: replaces the candidate's
 * provider metadata when the request body supplies a definitive
 * providerId (e.g. the user clicked "Codex" in the dropdown before
 * dropping a screenshot).
 */
export function applyExplicitProvider(
  candidate: ProviderUsageSnapshot,
  explicitProviderId: string | null | undefined,
): ProviderUsageSnapshot {
  if (explicitProviderId !== "minimax" && explicitProviderId !== "codex") {
    return candidate;
  }
  return {
    ...candidate,
    providerId: explicitProviderId,
    providerLabel: PROVIDER_DISPLAY[explicitProviderId] ?? candidate.providerLabel,
    accessType: "subscription",
  };
}

// Re-export a few enum types so consumers don't have to dig through
// the snapshot-shape module.
export type { SourceType, ConfidenceLevel };
export { ACCESS_TYPES, CONFIDENCE_LEVELS, SOURCE_TYPES };
