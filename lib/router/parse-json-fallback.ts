import "server-only";

/**
 * Safe JSON-object extraction from arbitrary LLM response text.
 *
 * Some recommender providers (notably MiniMax-M3) wrap their output in
 * ````<think>...`````` reasoning blocks and ```` ```json ... ``` ````
 * code fences even when the API request asked for strict JSON via
 * `response_format: { type: "json_schema" }`. AI SDK 6's
 * `Output.object({ schema })` calls `safeParseJSON` directly on the
 * raw text, which fails on the leading non-JSON characters and throws
 * `NoObjectGeneratedError` with `message: "No object generated: could
 * not parse the response."` and the raw response text on `error.text`.
 *
 * This helper performs ONLY safe JSON extraction — no field guessing,
 * no missing-field inference, no schema coercion. The caller is
 * responsible for schema validation against the authorized candidates
 * after extraction.
 *
 * The strategy is:
 *
 *   1. Try strict `JSON.parse` on the trimmed text. If it works, the
 *      provider gave us pure JSON; use it.
 *   2. Look for a markdown code-fenced JSON block
 *      (`` ```json ... ``` `` or `` ``` ... ``` ``) and try to parse
 *      the inner payload.
 *   3. Slice between the first `{` and the last `}`. This is the
 *      last-resort extraction — it can pick up prose-wrapped JSON
 *      but can ALSO pick up unrelated braces from human prose, so
 *      the parser MUST still re-validate against the schema before
 *      accepting the slice.
 *
 * All three strategies return the parsed object only when `JSON.parse`
 * succeeds AND the top-level value is a plain object. The helper
 * throws a descriptive error otherwise so the caller can surface the
 * specific failure mode ("raw", "fenced", or "brace-slice").
 *
 * Tests in `parse-json-fallback.test.ts` exercise every branch.
 */

export type JsonExtractionStrategy = "raw" | "fenced" | "brace-slice";

export type JsonExtractionSuccess = {
  ok: true;
  value: unknown;
  strategy: JsonExtractionStrategy;
};

export type JsonExtractionFailure = {
  ok: false;
  reason: string;
  /**
   * Trimmed prefix of the source text, used for diagnostics. Capped
   * to 200 chars so logs do not blow up on multi-KB provider
   * responses.
   */
  preview: string;
};

export function tryParseJsonObjectFromText(
  text: string | null | undefined,
): JsonExtractionSuccess | JsonExtractionFailure {
  const previewSource = typeof text === "string" ? text : "";
  const preview = previewSource.trim().slice(0, 200);
  if (!previewSource.trim()) {
    return {
      ok: false,
      reason: "recommender_returned_empty_text",
      preview: "",
    };
  }
  const trimmed = previewSource.trim();

  // Strategy 1: strict parse on the trimmed text.
  const raw = tryJsonParse(trimmed);
  if (raw.ok) {
    return { ok: true, value: raw.value, strategy: "raw" };
  }

  // Strategy 2: extract the first fenced ```json / ``` block.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) {
    const parsedFence = tryJsonParse(fenced);
    if (parsedFence.ok) {
      return { ok: true, value: parsedFence.value, strategy: "fenced" };
    }
  }

  // Strategy 3: slice between the first `{` and the last `}`. Only
  // attempt when both anchors are present; an unbalanced brace slice
  // would obviously fail to parse anyway.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = trimmed.slice(start, end + 1);
    const parsedSlice = tryJsonParse(slice);
    if (parsedSlice.ok) {
      return { ok: true, value: parsedSlice.value, strategy: "brace-slice" };
    }
  }

  return {
    ok: false,
    reason: "recommender_returned_non_json_object",
    preview,
  };
}

function tryJsonParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const value: unknown = JSON.parse(text);
    // The recommender output schema is always an object. Defensive
    // against a provider that returns `"hello"` or `[1, 2, 3]` —
    // those are valid JSON but not a valid recommender payload.
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false };
    }
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/**
 * Best-effort extraction that returns the raw response text from an
 * AI SDK 6 `NoObjectGeneratedError`. The error class exposes the raw
 * provider response on `.text` so a safe parser can have a second
 * attempt at extracting a valid JSON object.
 *
 * Returns `null` for non-AI-SDK errors or for AI SDK errors that do
 * not carry a text payload. The caller is expected to re-throw the
 * original error when this returns null.
 */
export function extractRawTextFromNoObjectError(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const candidate = err as { name?: unknown; text?: unknown };
  if (candidate.name !== "AI_NoObjectGeneratedError") {
    // Some AI SDK versions stringify the name; also accept a marker
    // check on the prototype so future renames do not silently break.
    const marker = (err as Record<symbol, unknown>)[
      Symbol.for("vercel.ai.error.AI_NoObjectGeneratedError")
    ];
    if (!marker) return null;
  }
  return typeof candidate.text === "string" ? candidate.text : null;
}

/**
 * Convenience wrapper around `tryParseJsonObjectFromText` + the
 * AI SDK 6 NoObjectGeneratedError text extraction. Returns the
 * parsed object when the error carries a parseable JSON payload;
 * otherwise returns `null` so the caller can re-throw the original
 * AI SDK error and surface its diagnostic verbatim.
 */
export function tryRecoverJsonObjectFromAiSdkError(
  err: unknown,
): JsonExtractionSuccess | JsonExtractionFailure | null {
  const text = extractRawTextFromNoObjectError(err);
  if (text === null) return null;
  return tryParseJsonObjectFromText(text);
}