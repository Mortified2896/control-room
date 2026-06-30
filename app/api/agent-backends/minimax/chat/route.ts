import { NextResponse } from "next/server";
import { resolveMiniMaxBinary, runMiniMaxExec } from "@/lib/minimax/runner";
import { probeMiniMaxStatus } from "@/lib/minimax/status";
import { assertModelExecutionAllowed, ProviderAccessError } from "@/lib/providers/access-control";

export const dynamic = "force-dynamic";
export const maxDuration = 200; // Next.js route timeout (seconds); runner timeout is 180s

/**
 * POST /api/agent-backends/minimax/chat
 *
 * Body: { message: string, model?: "MiniMax-M3", reasoningLevel?: string, cwd?: string }
 *
 * Runs `mmx run --json --prompt <message>` non-interactively in the
 * supplied project folder (or a hermes-owned scratch directory when
 * `cwd` is omitted). The MiniMax CLI is configured with the
 * `MINIMAX_API_KEY` env var; we never read or echo the key.
 *
 * Returns:
 *   {
 *     ok: boolean,
 *     responseText: string | null,
 *     error: string | null,
 *     errorKind: MiniMaxFailureKind | null,
 *     exitCode: number | null,
 *     durationMs: number | null,
 *     tokenUsage: null | { inputTokens, outputTokens, totalTokens }
 *   }
 *
 * Hard safety:
 *   - The prompt is passed as a single positional argument via
 *     `execFile`, never via a shell.
 *   - The runner never sets CWD inside the control-room repo.
 *   - 180s hard timeout on the subprocess, SIGKILL on overrun.
 *   - If MiniMax CLI is not installed or not authenticated, we
 *     return `ok: false` with a clear error message — the route
 *     does not fall back to OpenAI / Codex.
 */
export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        responseText: null,
        error: "request body must be JSON",
        errorKind: "internal",
        exitCode: null,
        durationMs: null,
        tokenUsage: null,
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      {
        ok: false,
        responseText: null,
        error: "body must be a JSON object",
        errorKind: "internal",
        exitCode: null,
        durationMs: null,
        tokenUsage: null,
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const message = (body as { message?: unknown }).message;
  const requestedModel = (body as { model?: unknown }).model;
  const requestedReasoningLevel = (body as { reasoningLevel?: unknown }).reasoningLevel;
  const requestedCwd = (body as { cwd?: unknown }).cwd;

  if (typeof message !== "string") {
    return NextResponse.json(
      {
        ok: false,
        responseText: null,
        error: "message must be a string",
        errorKind: "internal",
        exitCode: null,
        durationMs: null,
        tokenUsage: null,
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (requestedModel !== undefined && typeof requestedModel !== "string") {
    return NextResponse.json(
      {
        ok: false,
        responseText: null,
        error: "model must be a string",
        errorKind: "internal",
        exitCode: null,
        durationMs: null,
        tokenUsage: null,
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (requestedReasoningLevel !== undefined && typeof requestedReasoningLevel !== "string") {
    return NextResponse.json(
      {
        ok: false,
        responseText: null,
        error: "reasoningLevel must be a string",
        errorKind: "internal",
        exitCode: null,
        durationMs: null,
        tokenUsage: null,
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (requestedCwd !== undefined && typeof requestedCwd !== "string") {
    return NextResponse.json(
      {
        ok: false,
        responseText: null,
        error: "cwd must be a string",
        errorKind: "internal",
        exitCode: null,
        durationMs: null,
        tokenUsage: null,
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const model =
    typeof requestedModel === "string" && requestedModel.trim().length > 0
      ? requestedModel.trim()
      : "MiniMax-M3";

  try {
    await assertModelExecutionAllowed({
      providerId: "minimax_api",
      modelId: model,
      surface: "backend_test",
    });
  } catch (err) {
    if (err instanceof ProviderAccessError) {
      return NextResponse.json(
        {
          ok: false,
          responseText: null,
          error: err.message,
          errorKind: "auth",
          exitCode: null,
          durationMs: null,
          tokenUsage: null,
        },
        { status: err.status, headers: { "Cache-Control": "no-store" } },
      );
    }
    throw err;
  }

  // Preflight: if MiniMax CLI is not installed, short-circuit with a
  // clear message rather than letting execFile fail with a generic
  // ENOENT.
  const binary = resolveMiniMaxBinary();
  if (!binary) {
    return NextResponse.json(
      {
        ok: false,
        responseText: null,
        error:
          "MiniMax CLI is not installed on the server. Install with `npm install -g mmx-cli` and refresh.",
        errorKind: "internal",
        exitCode: null,
        durationMs: null,
        tokenUsage: null,
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const status = await probeMiniMaxStatus();
  if (status.status !== "logged_in") {
    const msg =
      status.status === "not_installed"
        ? "MiniMax CLI is not installed on the server. Install with: npm install -g mmx-cli"
        : status.status === "not_authenticated"
          ? "MiniMax CLI is installed but not authenticated. Run: mmx auth login --api-key <MINIMAX_API_KEY>"
          : (status.errorMessage ?? "MiniMax CLI is in an unknown state");
    return NextResponse.json(
      {
        ok: false,
        responseText: null,
        error: msg,
        errorKind: "auth",
        exitCode: null,
        durationMs: null,
        tokenUsage: null,
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await runMiniMaxExec(binary, {
    prompt: message,
    cwd: typeof requestedCwd === "string" ? requestedCwd : "/tmp",
    model,
    reasoningLevel:
      typeof requestedReasoningLevel === "string" ? requestedReasoningLevel : undefined,
  });
  if (!result.ok && (result.rawStderr || result.rawStdout)) {
    // Server-side debug only; never forwarded to the client.
    // eslint-disable-next-line no-console
    console.error("[minimax/chat] backend failure", {
      model,
      kind: result.errorKind,
      message: result.error,
      stderrTail: result.rawStderr
        ? result.rawStderr.replace(/\u001b\[[0-9;]*m/g, "").slice(-800)
        : null,
      stdoutTail: result.rawStdout
        ? result.rawStdout.replace(/\u001b\[[0-9;]*m/g, "").slice(-800)
        : null,
    });
  }
  const tokenUsage = result.ok ? result.tokenUsage : null;
  return NextResponse.json(
    {
      ok: result.ok,
      responseText: result.ok ? result.responseText : null,
      error: result.ok ? null : result.error,
      errorKind: result.ok ? null : (result.errorKind ?? "internal"),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      tokenUsage,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
