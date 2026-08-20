import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type WorkflowRunRef from "@hatchet-dev/typescript-sdk/util/workflow-run-ref";
import { context, propagation, SpanStatusCode, trace } from "@opentelemetry/api";

import type { AgentExecutionResult } from "../../lib/orchestration/agent-adapter";
import { controlRoomCorrelationMetadata } from "../../lib/orchestration/job-contract";
import type { MockAgentRequest } from "../../lib/orchestration/mock-agent-protocol";
import { createPilotMockRequest } from "../../lib/orchestration/pilot-job";
import { startPilotTelemetry } from "../../lib/orchestration/hatchet/telemetry";

const stateDirectory = resolve(process.env.HATCHET_PILOT_STATE_DIR ?? ".hatchet-pilot/runtime");
const evidenceDirectory = resolve(stateDirectory, "evidence");
const runnerTracer = trace.getTracer("control-room-hatchet-runner", "1.28.2");

async function main(): Promise<void> {
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });

  const telemetry = startPilotTelemetry({
    serviceName: "control-room-hatchet-pilot-runner",
    serviceVersion: "1.28.2",
    endpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  });

  try {
    const runtime = await import("../../lib/orchestration/hatchet/runtime");
    const command = process.argv[2] ?? "standard";

    if (command === "standard") {
      const evidence = await runStandard(runtime);
      await persistEvidence("standard.json", evidence);
      printResult(evidence);
    } else if (command === "enqueue-interruption") {
      const request = createPilotMockRequest({
        scenario: "commit_then_wait",
        durationMs: 90_000,
        maxRuntimeSeconds: 120,
        maxAttempts: 3,
        workspaceKey: "worker-interruption-workspace",
      });
      const ref = await runtime.agentJobTask.runNoWait(request, runOptions(runtime, request));
      const evidence = {
        command,
        run_id: await ref.runId,
        job_id: request.job.job_id,
        effect_id: effectId(request.job.idempotency_key),
        enqueued_at: new Date().toISOString(),
      };
      await persistEvidence("worker-interruption-enqueued.json", evidence);
      printResult(evidence);
    } else if (command === "enqueue-while-worker-down") {
      const request = createPilotMockRequest({ workspaceKey: "worker-down-workspace" });
      const ref = await runtime.agentJobTask.runNoWait(request, runOptions(runtime, request));
      const runId = await ref.runId;
      const status = await readStatus(runtime.hatchet, runId);
      const evidence = {
        command,
        run_id: runId,
        job_id: request.job.job_id,
        initial_status: status,
        enqueued_at: new Date().toISOString(),
      };
      await persistEvidence("worker-down-enqueued.json", evidence);
      printResult(evidence);
    } else if (command === "enqueue-service-outage") {
      const durationMs = Number(process.argv[3] ?? "8000");
      if (!Number.isInteger(durationMs) || durationMs < 1_000 || durationMs > 25_000) {
        throw new Error("service outage duration must be an integer from 1000 to 25000 ms");
      }
      const request = createPilotMockRequest({
        workspaceKey: "service-outage-workspace",
        scenario: "long_running",
        durationMs,
        maxRuntimeSeconds: 30,
      });
      const ref = await runtime.agentJobTask.runNoWait(request, runOptions(runtime, request));
      const evidence = {
        command,
        run_id: await ref.runId,
        job_id: request.job.job_id,
        duration_ms: durationMs,
        enqueued_at: new Date().toISOString(),
      };
      await persistEvidence("service-outage-enqueued.json", evidence);
      printResult(evidence);
    } else if (command === "wait-run") {
      const runId = requiredArgument(3, "run id");
      const ref = runtime.hatchet.runRef<AgentExecutionResult>(runId);
      const observed = await observeOutput(runtime.hatchet, ref, 120_000);
      const evidence = { command, run_id: runId, ...observed };
      await persistEvidence(`run-${runId}.json`, evidence);
      printResult(evidence);
    } else if (command === "probe") {
      const request = createPilotMockRequest({ workspaceKey: "availability-probe" });
      const enqueuedAt = new Date().toISOString();
      const ref = await enqueueWithTrace(runtime, request);
      const observed = await observeOutput(runtime.hatchet, ref, 30_000);
      const evidence = {
        command,
        run_id: await ref.runId,
        enqueued_at: enqueuedAt,
        dispatch_latency_ms: observed.output
          ? Date.parse(observed.output.started_at) - Date.parse(enqueuedAt)
          : undefined,
        ...observed,
      };
      await persistEvidence("availability-probe.json", evidence);
      printResult(evidence);
    } else {
      throw new Error(`unsupported integration command: ${command}`);
    }
  } finally {
    await telemetry.shutdown();
  }
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`integration failed: ${JSON.stringify(failureDiagnostic(error))}\n`);
    process.exit(1);
  },
);

type Runtime = typeof import("../../lib/orchestration/hatchet/runtime");

async function runStandard(runtime: Runtime) {
  const beganAt = new Date().toISOString();

  const successRequest = createPilotMockRequest({ workspaceKey: "success-workspace" });
  const successRef = await enqueueWithTrace(runtime, successRequest);
  const success = await observeOutput(runtime.hatchet, successRef, 30_000);
  assert.equal(success.status, "COMPLETED");
  assert.equal(success.output?.status, "succeeded");

  const retryRequest = createPilotMockRequest({
    workspaceKey: "retry-workspace",
    scenario: "transient_failure",
    failUntilAttempt: 1,
  });
  const retryRef = await runtime.agentJobTask.runNoWait(
    retryRequest,
    runOptions(runtime, retryRequest),
  );
  const retry = await observeOutput(runtime.hatchet, retryRef, 45_000);
  assert.equal(retry.status, "COMPLETED");
  assert.equal(retry.output?.attempt, 2);

  const failureRequest = createPilotMockRequest({
    workspaceKey: "failure-workspace",
    scenario: "permanent_failure",
  });
  const failureRef = await runtime.agentJobTask.runNoWait(
    failureRequest,
    runOptions(runtime, failureRequest),
  );
  const failure = await observeOutput(runtime.hatchet, failureRef, 30_000);
  assert.equal(failure.status, "FAILED");
  assert.equal(failure.output, undefined);

  const timeoutRequest = createPilotMockRequest({
    workspaceKey: "timeout-workspace",
    scenario: "long_running",
    durationMs: 20_000,
    maxRuntimeSeconds: 30,
    maxAttempts: 1,
  });
  const timeoutRef = await runtime.timeoutProbeTask.runNoWait(
    timeoutRequest,
    runOptions(runtime, timeoutRequest),
  );
  const timeout = await observeOutput(runtime.hatchet, timeoutRef, 30_000);
  assert.equal(timeout.status, "FAILED");
  await waitForEventPattern(timeoutRequest.job.job_id, /"kind":"terminated"/, 5_000);

  const cancellationRequest = createPilotMockRequest({
    workspaceKey: "cancellation-workspace",
    scenario: "long_running",
    durationMs: 30_000,
    maxRuntimeSeconds: 60,
  });
  const cancellationRef = await runtime.agentJobTask.runNoWait(
    cancellationRequest,
    runOptions(runtime, cancellationRequest),
  );
  await waitForStatus(runtime.hatchet, cancellationRef, ["RUNNING"], 20_000);
  const cancellationRequestedAt = Date.now();
  await cancellationRef.cancel();
  const cancellation = await observeOutput(runtime.hatchet, cancellationRef, 30_000);
  assert.equal(cancellation.status, "CANCELLED");
  await waitForEventPattern(cancellationRequest.job.job_id, /"signal":"SIGTERM"/, 5_000);
  const cancellationTerminalLatencyMs = Date.now() - cancellationRequestedAt;

  const sameWorkspace = "serialized-workspace";
  const sameARequest = createPilotMockRequest({ workspaceKey: sameWorkspace, durationMs: 800 });
  const sameBRequest = createPilotMockRequest({ workspaceKey: sameWorkspace, durationMs: 800 });
  const sameARef = await runtime.agentJobTask.runNoWait(
    sameARequest,
    runOptions(runtime, sameARequest),
  );
  const sameBRef = await runtime.agentJobTask.runNoWait(
    sameBRequest,
    runOptions(runtime, sameBRequest),
  );
  const [sameA, sameB] = await Promise.all([sameARef.output, sameBRef.output]);
  assert.equal(intervalsOverlap(sameA, sameB), false);

  const distinctARequest = createPilotMockRequest({
    workspaceKey: "parallel-workspace-a",
    durationMs: 800,
  });
  const distinctBRequest = createPilotMockRequest({
    workspaceKey: "parallel-workspace-b",
    durationMs: 800,
  });
  const distinctARef = await runtime.agentJobTask.runNoWait(
    distinctARequest,
    runOptions(runtime, distinctARequest),
  );
  const distinctBRef = await runtime.agentJobTask.runNoWait(
    distinctBRequest,
    runOptions(runtime, distinctBRequest),
  );
  const [distinctA, distinctB] = await Promise.all([distinctARef.output, distinctBRef.output]);
  assert.equal(intervalsOverlap(distinctA, distinctB), true);

  const duplicateRequest = createPilotMockRequest({
    workspaceKey: "duplicate-trigger-workspace",
    durationMs: 1_500,
  });
  const originalRef = await runtime.agentJobTask.runNoWait(
    duplicateRequest,
    runOptions(runtime, duplicateRequest),
  );
  await waitForStatus(runtime.hatchet, originalRef, ["RUNNING"], 20_000);
  let duplicateCollision = false;
  let duplicateExistingRunId: string | undefined;
  try {
    const duplicateRef = await runtime.agentJobTask.runNoWait(
      duplicateRequest,
      runOptions(runtime, duplicateRequest),
    );
    await duplicateRef.runId;
  } catch (error) {
    if (isIdempotencyCollision(error)) {
      duplicateCollision = true;
      duplicateExistingRunId = error.existingRunExternalId;
    }
  }
  assert.equal(duplicateCollision, true);
  const originalOutput = await originalRef.output;

  const scheduledRequest = createPilotMockRequest({
    workspaceKey: "scheduled-workspace",
    priority: "medium",
  });
  const scheduledFor = new Date(Date.now() + 2_500);
  const scheduled = await runtime.agentJobTask.schedule(
    scheduledFor,
    scheduledRequest,
    runOptions(runtime, scheduledRequest),
  );
  const scheduledExecution = await waitForEventCompletion(scheduledRequest.job.job_id, 30_000);
  assert.ok(Date.parse(scheduledExecution.started_at) >= scheduledFor.getTime() - 250);

  const priorityWorkspace = "priority-workspace";
  const blockerRequest = createPilotMockRequest({
    workspaceKey: priorityWorkspace,
    durationMs: 1_500,
    priority: "low",
  });
  const blockerRef = await runtime.agentJobTask.runNoWait(
    blockerRequest,
    runOptions(runtime, blockerRequest),
  );
  await waitForStatus(runtime.hatchet, blockerRef, ["RUNNING"], 20_000);
  const lowRequest = createPilotMockRequest({
    workspaceKey: priorityWorkspace,
    priority: "low",
  });
  const highRequest = createPilotMockRequest({
    workspaceKey: priorityWorkspace,
    priority: "high",
  });
  const lowRef = await runtime.agentJobTask.runNoWait(lowRequest, runOptions(runtime, lowRequest));
  const highRef = await runtime.agentJobTask.runNoWait(
    highRequest,
    runOptions(runtime, highRequest),
  );
  await blockerRef.output;
  const [lowOutput, highOutput] = await Promise.all([lowRef.output, highRef.output]);
  assert.ok(Date.parse(highOutput.started_at) <= Date.parse(lowOutput.started_at));

  return {
    schema_version: 1,
    began_at: beganAt,
    finished_at: new Date().toISOString(),
    versions: {
      hatchet_server: runtime.HATCHET_SERVER_VERSION,
      typescript_sdk: runtime.HATCHET_TYPESCRIPT_SDK_VERSION,
    },
    cases: {
      success,
      retry: { ...retry, observed_attempt: retry.output?.attempt },
      permanent_failure: failure,
      timeout: {
        ...timeout,
        child_terminated: true,
      },
      cancellation: {
        ...cancellation,
        child_terminated: true,
        terminal_and_child_signal_latency_ms: cancellationTerminalLatencyMs,
      },
      concurrency: {
        same_workspace_serialized: !intervalsOverlap(sameA, sameB),
        distinct_workspaces_overlapped: intervalsOverlap(distinctA, distinctB),
        same_workspace_run_ids: [await sameARef.runId, await sameBRef.runId],
        distinct_workspace_run_ids: [await distinctARef.runId, await distinctBRef.runId],
      },
      idempotency: {
        collision_observed: duplicateCollision,
        original_run_id: await originalRef.runId,
        existing_run_id: duplicateExistingRunId,
        original_effect_status: originalOutput.status,
      },
      scheduling: {
        schedule_id: scheduled.metadata.id,
        scheduled_for: scheduledFor.toISOString(),
        run_id: scheduledExecution.hatchet_run_id,
        started_at: scheduledExecution.started_at,
        status: "COMPLETED",
      },
      priority: {
        scope: "same task only",
        high_started_at: highOutput.started_at,
        low_started_at: lowOutput.started_at,
        high_started_first: Date.parse(highOutput.started_at) <= Date.parse(lowOutput.started_at),
      },
    },
  };
}

async function enqueueWithTrace(
  runtime: Runtime,
  request: MockAgentRequest,
): Promise<WorkflowRunRef<AgentExecutionResult>> {
  const parentContext = request.job.trace_context
    ? propagation.extract(context.active(), request.job.trace_context)
    : context.active();

  return context.with(parentContext, () =>
    runnerTracer.startActiveSpan(
      "control_room.agent_job.enqueue",
      { attributes: controlRoomCorrelationMetadata(request.job) },
      async (span) => {
        try {
          const ref = await runtime.agentJobTask.runNoWait(request, runOptions(runtime, request));
          span.setAttribute("control_room.hatchet_run_id", await ref.runId);
          span.setStatus({ code: SpanStatusCode.OK });
          return ref;
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    ),
  );
}

function runOptions(runtime: Runtime, request: MockAgentRequest) {
  return {
    priority: runtime.priorityFor(request.job.priority),
    additionalMetadata: controlRoomCorrelationMetadata(request.job),
  };
}

async function observeOutput(
  hatchet: Runtime["hatchet"],
  ref: WorkflowRunRef<AgentExecutionResult>,
  timeoutMs: number,
): Promise<{
  status: string;
  statuses_observed: string[];
  output?: AgentExecutionResult;
  failure_code?: string;
}> {
  const statuses = new Set<string>();
  const runId = await ref.runId;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await readStatus(hatchet, runId);
    statuses.add(status);
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(status)) break;
    await delay(200);
  }

  let output: AgentExecutionResult | undefined;
  let failureCode: string | undefined;
  try {
    output = await Promise.race([
      ref.output,
      delay(timeoutMs).then(() => {
        throw new Error("output_timeout");
      }),
    ]);
  } catch (error) {
    failureCode = classifyFailure(error);
  }

  const status = await readStatus(hatchet, runId);
  statuses.add(status);
  return {
    status,
    statuses_observed: [...statuses],
    output,
    failure_code: failureCode,
  };
}

async function waitForStatus(
  hatchet: Runtime["hatchet"],
  ref: WorkflowRunRef<unknown>,
  expected: string[],
  timeoutMs: number,
): Promise<string> {
  const runId = await ref.runId;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await readStatus(hatchet, runId);
    if (expected.includes(status)) return status;
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(status)) {
      throw new Error(`run reached terminal status ${status}`);
    }
    await delay(150);
  }
  throw new Error(`status wait timed out for ${runId}`);
}

async function readStatus(hatchet: Runtime["hatchet"], runId: string): Promise<string> {
  return String((await hatchet.runs.getDetails(runId)).status);
}

async function waitForEventCompletion(
  jobId: string,
  timeoutMs: number,
): Promise<{ hatchet_run_id?: string; started_at: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const events = (await eventLog(jobId))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const started = events.find((event) => event.kind === "started");
      const finished = events.find((event) => event.kind === "finished");
      if (started && finished && typeof started.at === "string") {
        return {
          hatchet_run_id:
            typeof started.hatchet_run_id === "string" ? started.hatchet_run_id : undefined,
          started_at: started.at,
        };
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await delay(200);
  }
  throw new Error(`scheduled execution did not complete for ${jobId}`);
}

function intervalsOverlap(a: AgentExecutionResult, b: AgentExecutionResult): boolean {
  return (
    Date.parse(a.started_at) < Date.parse(b.finished_at) &&
    Date.parse(b.started_at) < Date.parse(a.finished_at)
  );
}

function isIdempotencyCollision(
  error: unknown,
): error is Error & { existingRunExternalId: string } {
  return (
    error instanceof Error &&
    error.name === "IdempotencyCollisionError" &&
    "existingRunExternalId" in error &&
    typeof error.existingRunExternalId === "string"
  );
}

function classifyFailure(error: unknown): string {
  if (error instanceof Error) {
    for (const code of [
      "mock_permanent_failure",
      "timeout",
      "cancelled",
      "output_timeout",
      "TaskRunError",
    ]) {
      if (error.name === code || error.message.includes(code)) return code;
    }
    return error.name;
  }
  return "unknown_failure";
}

function failureDiagnostic(error: unknown): Record<string, string | number | undefined> {
  const transport = error as {
    actual?: unknown;
    code?: string;
    config?: { baseURL?: string; method?: string; url?: string };
    expected?: unknown;
    operator?: string;
    response?: { status?: number };
    stack?: string;
  };
  return {
    failure_class: classifyFailure(error),
    transport_code: transport.code,
    http_status: transport.response?.status,
    method: transport.config?.method,
    endpoint: safeEndpoint(transport.config?.baseURL, transport.config?.url),
    assertion_actual: scalarDiagnostic(transport.actual),
    assertion_expected: scalarDiagnostic(transport.expected),
    assertion_operator: transport.operator,
    location: transport.stack?.split("\n")[1]?.trim(),
  };
}

function scalarDiagnostic(value: unknown): string | number | undefined {
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return String(value);
  return undefined;
}

function safeEndpoint(baseUrl?: string, path?: string): string | undefined {
  try {
    return new URL(path ?? "", baseUrl).pathname;
  } catch {
    return undefined;
  }
}

async function eventLog(jobId: string): Promise<string> {
  const name = `${createHash("sha256").update(jobId).digest("hex")}.jsonl`;
  return readFile(resolve(stateDirectory, "events", name), "utf8");
}

async function waitForEventPattern(
  jobId: string,
  pattern: RegExp,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (pattern.test(await eventLog(jobId))) return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await delay(100);
  }
  throw new Error(`event pattern was not observed for ${jobId}`);
}

function effectId(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

async function persistEvidence(name: string, evidence: unknown): Promise<void> {
  await writeFile(resolve(evidenceDirectory, name), `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
}

function printResult(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function requiredArgument(index: number, name: string): string {
  const value = process.argv[index];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
