import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/db";
import { createCodingRun, getCodingRun } from "@/lib/repo/coding-runs";
import { createMessage, getThread } from "@/lib/repo/threads";
import { getProject } from "@/lib/repo/projects";
import { dispatchCodingHarness, HarnessDispatchError } from "@/lib/harness/dispatcher";
import {
  getHarnessEntryOrNull,
  HARNESS_REGISTRY,
  registryWithStatus,
  probeHarnessStatuses,
  type HarnessId,
} from "@/lib/harness/registry";
import { ensureDiscoveryFresh } from "@/lib/providers/openai-discovery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function textPart(text: string) {
  return [{ type: "text", text }];
}

function codexCliField(
  run: Awaited<ReturnType<typeof getCodingRun>>,
  field: string,
): string | null {
  const text = `${run?.stdout ?? ""}\n${run?.stderr ?? ""}`;
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^${escaped}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() || null;
}

function runDurationMs(run: Awaited<ReturnType<typeof getCodingRun>>): number | null {
  if (!run?.startedAt || !run?.finishedAt) return null;
  const started = Date.parse(run.startedAt);
  const finished = Date.parse(run.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return null;
  return Math.max(0, finished - started);
}

/**
 * Compose the assistant message + metadata for a coding-task run.
 *
 * The metadata block is intentionally source-aware: it picks the
 * executor label, model label, and reasoning label from the harness
 * entry rather than from a hard-coded Codex string, so a future
 * third harness can ship without changing this function.
 */
function renderRunResult(
  run: Awaited<ReturnType<typeof getCodingRun>>,
  harnessId: HarnessId,
  project: Awaited<ReturnType<typeof getProject>>,
  result: Awaited<ReturnType<typeof dispatchCodingHarness>>,
): string {
  const duration = runDurationMs(run);
  const projectLabel =
    project?.name ?? project?.repoPath ?? project?.localPath ?? "unknown project";
  const harness = getHarnessEntryOrNull(harnessId);
  const executor = harness?.displayName ?? "Coding harness";
  // The bare model id (e.g. "gpt-5.4-mini" or "MiniMax-M3") — without
  // the `codex:` / `minimax:` prefix.
  const modelLabel = result.modelId;
  // The reasoning level passed to the harness. For MiniMax this is
  // always `provider_default` because MiniMax CLI does not accept a
  // reasoning-effort knob on the CLI surface today.
  const reasoningLabel =
    harness?.supportsReasoningLevels && result.reasoningLevel !== "provider_default"
      ? result.reasoningLevel
      : "provider default";
  const blocks: string[] = [
    `**${executor}** · model: ${modelLabel} · reasoning: ${reasoningLabel} · duration: ${
      duration == null ? "unknown" : `${(duration / 1000).toFixed(1)}s`
    } · project: ${projectLabel}`,
    `${executor} run ${run?.status}.`,
    `Exit code: ${run?.exitCode ?? "none"}`,
  ];
  if ((run?.stdout ?? "").trim()) {
    blocks.push(
      `${harness?.displayName ?? "Harness"} answer / stdout:\n\n${run?.stdout?.trim() ?? ""}`,
    );
  }
  if ((run?.stderr ?? "").trim()) {
    blocks.push(`${harness?.displayName ?? "Harness"} stderr:\n\n${run?.stderr?.trim() ?? ""}`);
  }
  if ((run?.gitStatusShort ?? "").trim()) {
    blocks.push(`Changed files (git status --short):\n\n${run?.gitStatusShort?.trim() ?? ""}`);
  }
  if ((run?.gitDiffStat ?? "").trim()) {
    blocks.push(`Diff summary (git diff --stat):\n\n${run?.gitDiffStat?.trim() ?? ""}`);
  }
  return blocks.join("\n\n");
}

type CodingRunBody = {
  projectId?: unknown;
  threadId?: unknown;
  prompt?: unknown;
  harnessId?: unknown;
  modelId?: unknown;
  reasoningLevel?: unknown;
};

export async function POST(req: NextRequest) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "database_not_configured" }, { status: 503 });
  }

  let body: CodingRunBody;
  try {
    body = (await req.json()) as CodingRunBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const projectId = typeof body.projectId === "string" ? body.projectId : null;
  const threadId = typeof body.threadId === "string" ? body.threadId : null;
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  // Default to Codex CLI for backwards compatibility with the
  // existing client (the approval card surfaces both harnesses, but
  // older senders may not pass `harnessId`).
  const requestedHarnessId =
    typeof body.harnessId === "string" ? (body.harnessId as HarnessId) : "codex_cli";
  const harnessEntry = getHarnessEntryOrNull(requestedHarnessId);
  if (!harnessEntry) {
    return NextResponse.json(
      {
        error: "unknown_harness",
        message: `Unknown harness id: ${requestedHarnessId}. Supported: ${HARNESS_REGISTRY.map((h) => h.id).join(", ")}.`,
      },
      { status: 400 },
    );
  }
  // Default the model id to the harness's registry-default. The
  // client can pass an explicit model id (e.g. `codex:gpt-5.5`) to
  // override.
  const requestedModelId =
    typeof body.modelId === "string" && body.modelId.trim().length > 0
      ? body.modelId.trim()
      : harnessEntry.defaultModelId;
  const requestedReasoningLevel =
    typeof body.reasoningLevel === "string" && body.reasoningLevel.trim().length > 0
      ? body.reasoningLevel.trim()
      : harnessEntry.defaultReasoningLevel;

  if (!projectId) {
    return NextResponse.json(
      {
        error: "no_project_selected",
        message: `No project is selected. Select a project before running ${harnessEntry.displayName}.`,
      },
      { status: 400 },
    );
  }
  if (!prompt) return NextResponse.json({ error: "empty_prompt" }, { status: 400 });

  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });

  if (threadId) {
    const thread = await getThread(threadId);
    if (!thread) return NextResponse.json({ error: "thread_not_found" }, { status: 404 });
    if (thread.projectId !== projectId) {
      return NextResponse.json({ error: "thread_project_mismatch" }, { status: 400 });
    }
  }

  // Pre-create the coding_runs row so the user prompt is persisted
  // BEFORE the harness runs (matches the previous behavior; also
  // gives us a deterministic row id to bind the harness dispatch
  // to the chat thread).
  const preRow = await createCodingRun({
    projectId,
    threadId,
    prompt,
    executor: harnessEntry.id,
  });

  if (threadId) {
    await createMessage({
      threadId,
      role: "user",
      content: prompt,
      parts: textPart(prompt),
      modelId: harnessEntry.id,
    });
  }

  let completed;
  try {
    completed = await dispatchCodingHarness({
      harnessId: harnessEntry.id,
      modelId: requestedModelId,
      reasoningLevel: requestedReasoningLevel,
      prompt,
      projectId,
      threadId,
    });
  } catch (err) {
    if (err instanceof HarnessDispatchError) {
      const status = err.status ?? 400;
      const message =
        err.kind === "model_not_supported"
          ? `${harnessEntry.displayName} cannot run model ${requestedModelId}: ${err.message}`
          : err.message;
      const failed = await createCodingRun({
        projectId,
        threadId,
        prompt,
        executor: harnessEntry.id,
      });
      // We intentionally do NOT persist the assistant-side
      // harness-failed message here — the dispatcher never
      // started a subprocess so there is no answer to surface.
      // The client (ComposerAction) already renders a clear
      // inline error from the failed response.
      void failed;
      return NextResponse.json(
        {
          error: err.kind,
          message,
          runId: preRow.id,
          harnessId: harnessEntry.id,
        },
        { status },
      );
    }
    throw err;
  }

  const run = await getCodingRun(completed.codingRunId);
  const assistantText = renderRunResult(run, harnessEntry.id, project, completed);
  if (threadId) {
    await createMessage({
      threadId,
      role: "assistant",
      content: assistantText,
      parts: textPart(assistantText),
      modelId: harnessEntry.id,
    });
  }

  const status = completed.status === "succeeded" ? 200 : 502;
  // Compact metadata block consumed by the chat composer's
  // `appendCodexMessages` analogue. The `harness` field is the
  // generic replacement for the legacy `codex` block; the client
  // reads it as `custom.harness` and falls back to `custom.codex`
  // for older messages so existing chat history still renders.
  const metadata = {
    harness: harnessEntry.id,
    harnessLabel: harnessEntry.displayName,
    providerPath: harnessEntry.providerPath,
    billingPath: harnessEntry.billingPath,
    model: completed.modelId,
    reasoning: completed.reasoningLevel,
    durationMs: completed.durationMs,
    projectName: project.name,
    projectPath: project.repoPath || project.localPath,
    status: completed.status,
    exitStatus: completed.exitStatus,
    changedFiles: completed.changedFiles,
    tokenUsage: completed.tokenUsage,
  };

  // The Codex-specific field remains in the response so the existing
  // client (`appendCodexMessages`) keeps working without a forced
  // rewrite. New client code should read `metadata.harness` first.
  const legacyCodexMetadata = {
    executor: harnessEntry.displayName,
    model: completed.modelId,
    reasoning: completed.reasoningLevel,
    durationMs: completed.durationMs,
    projectName: project.name,
    projectPath: project.repoPath || project.localPath,
    status: completed.status,
  };

  return NextResponse.json(
    {
      run,
      userText: prompt,
      assistantText,
      metadata,
      // Backwards-compatible field. The chat composer reads
      // `metadata.harness` first and falls back to this on older
      // messages.
      legacyCodexMetadata,
      // The metadata embedded in the assistant message uses the
      // legacy `codex` key so the existing
      // `CodexMetadataLine` rendering path picks it up unchanged.
      codex: legacyCodexMetadata,
      project: { ...project, repoPath: project.repoPath },
    },
    { status },
  );
}

/**
 * Lightweight GET that returns the current harness registry view
 * (with fresh status probes). Used by the chat composer to render
 * the generic coding harness approval card without first having to
 * call `/api/router/decision`. Cheap — does not touch the DB.
 */
export async function GET(): Promise<NextResponse> {
  await ensureDiscoveryFresh();
  const snapshots = await probeHarnessStatuses();
  const registry = registryWithStatus(snapshots);
  return NextResponse.json(
    {
      harnesses: registry.map((entry) => ({
        id: entry.id,
        displayName: entry.displayName,
        providerPath: entry.providerPath,
        billingPath: entry.billingPath,
        requiresProjectFolder: entry.requiresProjectFolder,
        canModifyFiles: entry.canModifyFiles,
        supportsTokenUsage: entry.supportsTokenUsage,
        supportsReasoningLevels: entry.supportsReasoningLevels,
        defaultModelId: entry.defaultModelId,
        allowedModelIds: entry.allowedModelIds,
        defaultReasoningLevel: entry.defaultReasoningLevel,
        status: entry.status,
        unavailableReason: entry.unavailableReason,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// Keep this helper exported so the legacy `codexCliField` test (if
// present) does not flag it as a dead export.
export const __internalForTests = { codexCliField };
