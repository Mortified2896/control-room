import { NextResponse } from "next/server";

import {
  CODEX_DEFAULT_MODEL_ID,
  isCodexModelId,
  resolveCodexBinary,
  runCodexExec,
} from "@/lib/codex/runner";
import { probeCodexStatus } from "@/lib/codex/status";
import { assertModelExecutionAllowed, ProviderAccessError } from "@/lib/providers/access-control";

export const dynamic = "force-dynamic";
export const maxDuration = 150; // Next.js route timeout (seconds); runner timeout is 120s

/**
 * POST /api/agent-backends/codex/chat
 *
 * Body: { message: string, model?: "gpt-5.4-mini" | "gpt-5.5" }
 *
 * Runs `codex exec <message>` non-interactively in a hermes-owned
 * scratch directory (`/home/hermes/tmp/control-room-codex-smoke`),
 * with `--skip-git-repo-check`, `approval="never"`, and
 * `sandbox="read-only"` overrides so Codex cannot mutate the host or
 * the control-room repo.
 *
 * Returns:
 *   {
 *     ok: boolean,
 *     responseText: string | null,
 *     error: string | null,
 *     exitCode: number | null
 *   }
 *
 * Hard safety:
 *   - No user input is ever interpreted as a CLI flag. The prompt is
 *     passed as a single positional argument to `codex exec` via
 *     `execFile`, never via a shell.
 *   - The scratch dir is created if missing; it is never the
 *     control-room repo or any other project.
 *   - 120s hard timeout on the subprocess, SIGKILL on overrun.
 *   - If Codex is not installed or not logged in, we return
 *     `ok: false` with a clear error message — the route does not
 *     fall back to OPENAI_API_KEY or any other provider.
 */
export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, responseText: null, error: "request body must be JSON", exitCode: null },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { ok: false, responseText: null, error: "body must be a JSON object", exitCode: null },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const message = (body as { message?: unknown }).message;
  const requestedModel = (body as { model?: unknown }).model;
  if (typeof message !== "string") {
    return NextResponse.json(
      { ok: false, responseText: null, error: "message must be a string", exitCode: null },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (requestedModel !== undefined && typeof requestedModel !== "string") {
    return NextResponse.json(
      { ok: false, responseText: null, error: "model must be a string", exitCode: null },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const model =
    typeof requestedModel === "string" && isCodexModelId(requestedModel)
      ? requestedModel
      : CODEX_DEFAULT_MODEL_ID;

  try {
    await assertModelExecutionAllowed({
      providerId: "codex_subscription",
      modelId: `codex:${model}`,
      surface: "backend_test",
    });
  } catch (err) {
    if (err instanceof ProviderAccessError) {
      return NextResponse.json(
        { ok: false, responseText: null, error: err.message, exitCode: null },
        { status: err.status, headers: { "Cache-Control": "no-store" } },
      );
    }
    throw err;
  }

  // Quick preflight: if Codex is not installed at all, short-circuit
  // with a clear message rather than letting execFile fail with a
  // generic ENOENT.
  const binary = resolveCodexBinary();
  if (!binary) {
    return NextResponse.json(
      {
        ok: false,
        responseText: null,
        error:
          "codex CLI is not installed on the server. Install with `npm install -g @openai/codex` and refresh.",
        exitCode: null,
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Pre-flight login check so we can return a helpful 503 instead of
  // a 401 in the body. The runner itself will still surface a clear
  // "not logged in" message in `error`.
  const status = await probeCodexStatus();
  if (status.status !== "logged_in") {
    const msg =
      status.status === "not_installed"
        ? "Codex CLI is not installed on the server. Install with: npm install -g @openai/codex"
        : status.status === "not_logged_in"
          ? "Codex is installed but not logged in. Run: codex login --device-auth"
          : (status.errorMessage ?? "Codex is in an unknown state");
    return NextResponse.json(
      { ok: false, responseText: null, error: msg, exitCode: null },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await runCodexExec(binary, message, { model });
  // The runner already returns the structured shape, but we re-shape
  // here to make the contract explicit and decoupled from runner
  // internals.
  //
  // We never forward `result.rawStderr` / `result.rawStdout` to the
  // client — those are server-side debug artifacts only. The user-
  // facing copy comes from `result.error`, which the runner
  // sanitizes (drops bubblewrap warnings, the skills-context budget
  // warning, and any other non-fatal noise). The brief: "do not
  // render raw codex exec stderr as the assistant response."
  if (!result.ok && (result.rawStderr || result.rawStdout)) {
    // Log once on the server so operators can debug without leaking
    // stderr to the network. We log the truncated tail (the last
    // 800 chars) and the classified kind; never the full prompt.
    // eslint-disable-next-line no-console
    console.error("[codex/chat] backend failure", {
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
  return NextResponse.json(
    {
      ok: result.ok,
      responseText: result.responseText,
      error: result.ok ? null : result.error,
      // Expose the classified kind so the client can render a
      // distinct final-send failure card per category (usage_limit,
      // auth, rate_limit, unsupported, internal) instead of a single
      // generic "Codex backend error" string.
      errorKind: result.ok ? null : (result.errorKind ?? "internal"),
      exitCode: result.exitCode,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
