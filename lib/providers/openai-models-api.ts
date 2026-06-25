import "server-only";

/**
 * Server-only HTTP client for OpenAI's GET /v1/models endpoint.
 *
 * Why hand-rolled `fetch` instead of the AI SDK:
 *   - The list endpoint is a single GET, no streaming, no tool calls, no
 *     structured output. Pulling in `@ai-sdk/openai` here would drag a
 *     provider class through the discovery path and obscure the failure
 *     modes (timeouts, 401, 429) behind SDK exceptions.
 *   - Discovery is rare (manual refresh + Settings UI) so the cold-start
 *     cost of an extra SDK call is irrelevant.
 *
 * The endpoint returns:
 *   { "object": "list",
 *     "data": [{ "id": "...", "object": "model", "created": ..., "owned_by": "..." }, ...],
 *     "has_more": false }
 *
 * We only extract `data[*].id`. Other fields are preserved by the API
 * surface but not consumed by Control Room yet — see
 * `docs/POSTGRES_PLAN.md` for the rationale on minimal payloads.
 */

export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const OPENAI_MODELS_PATH = "/models";
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;

export type OpenAIModelsApiEntry = {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
};

export type OpenAIModelsApiResponse = {
  object?: string;
  data?: ReadonlyArray<OpenAIModelsApiEntry>;
  has_more?: boolean;
};

export type FetchOpenAIModelsResult =
  | { ok: true; modelIds: ReadonlyArray<string>; httpStatus: number; rawCount: number }
  | { ok: false; httpStatus: number | null; reason: string };

/**
 * Hit `GET /v1/models` on the OpenAI API. Returns the deduplicated,
 * sorted list of model ids or a structured failure (network error,
 * non-2xx, parse error).
 *
 * Caller (`lib/providers/openai-discovery.ts`) decides how to react to
 * the failure: persist the error via `writeDiscoveryFailure`, then fall
 * back to the cached snapshot.
 */
export async function fetchOpenAIModels(opts: {
  apiKey: string;
  signal?: AbortSignal;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<FetchOpenAIModelsResult> {
  const apiKey = opts.apiKey?.trim() ?? "";
  if (!apiKey) {
    return { ok: false, httpStatus: null, reason: "OPENAI_API_KEY is not set" };
  }
  const baseUrl = (opts.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, "");
  const url = `${baseUrl}${OPENAI_MODELS_PATH}`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal,
      cache: "no-store",
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, httpStatus: null, reason: `network error: ${reason}` };
  }
  const httpStatus = res.status;
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.text()) ?? "";
      detail = body.slice(0, 200);
    } catch {
      // body read failure is non-fatal
    }
    return {
      ok: false,
      httpStatus,
      reason: `OpenAI /v1/models responded ${httpStatus}${detail ? `: ${detail}` : ""}`,
    };
  }
  let parsed: OpenAIModelsApiResponse | null = null;
  try {
    parsed = (await res.json()) as OpenAIModelsApiResponse;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, httpStatus, reason: `parse error: ${reason}` };
  }
  const data = Array.isArray(parsed.data) ? parsed.data : [];
  const ids = [
    ...new Set(
      data.map((d) => d.id).filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ].sort();
  return { ok: true, modelIds: ids, httpStatus, rawCount: data.length };
}
