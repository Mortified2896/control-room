import "server-only";

export type MiniMaxModelsFetchResult =
  | { ok: true; modelIds: string[]; httpStatus: number; rawCount: number }
  | { ok: false; reason: string; httpStatus: number | null };

type MiniMaxModelsResponse = {
  data?: unknown;
};

function sanitizeModelId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  if (!trimmed || trimmed.length > 200) return null;
  // Avoid surfacing non-model placeholders or obviously unsafe values.
  if (trimmed.includes("\n") || trimmed.includes("\r")) return null;
  return trimmed;
}

function isLikelyChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  if (lower.includes("embedding") || lower.includes("image") || lower.includes("speech")) {
    return false;
  }
  return true;
}

export async function fetchMiniMaxModels(input: {
  apiKey: string;
  baseURL: string;
  timeoutMs?: number;
}): Promise<MiniMaxModelsFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000);
  const base = input.baseURL.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: MiniMaxModelsResponse | null = null;
    try {
      parsed = text ? (JSON.parse(text) as MiniMaxModelsResponse) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        reason: `MiniMax /models request failed with HTTP ${res.status}`,
      };
    }
    const data = Array.isArray(parsed?.data) ? parsed.data : [];
    const ids = data
      .map((item) => sanitizeModelId((item as { id?: unknown } | null)?.id))
      .filter((id): id is string => Boolean(id))
      .filter(isLikelyChatModel);
    return {
      ok: true,
      httpStatus: res.status,
      modelIds: [...new Set(ids)].sort(),
      rawCount: data.length,
    };
  } catch (err) {
    return {
      ok: false,
      httpStatus: null,
      reason:
        err instanceof Error && err.name === "AbortError"
          ? "MiniMax /models request timed out"
          : "MiniMax /models request failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}
