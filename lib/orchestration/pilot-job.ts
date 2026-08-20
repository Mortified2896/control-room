import { randomUUID } from "node:crypto";

import { parseControlRoomAgentJob, type ControlRoomAgentJob } from "./job-contract";
import { mockAgentRequestSchema, type MockAgentRequest } from "./mock-agent-protocol";

export function createPilotMockRequest(
  options: {
    jobId?: string;
    correlationId?: string;
    workspaceKey?: string;
    idempotencyKey?: string;
    scenario?: MockAgentRequest["mock"]["scenario"];
    durationMs?: number;
    failUntilAttempt?: number;
    maxAttempts?: number;
    maxRuntimeSeconds?: number;
    priority?: ControlRoomAgentJob["priority"];
  } = {},
): MockAgentRequest {
  const workspaceKey = options.workspaceKey ?? `workspace-${randomUUID()}`;
  const jobId = options.jobId ?? randomUUID();
  const job = parseControlRoomAgentJob({
    schema_version: 1,
    job_id: jobId,
    created_at: new Date().toISOString(),
    repository: {
      repository_id: `repository-${workspaceKey}`,
      workspace_key: workspaceKey,
    },
    requested_ref: "refs/heads/pilot",
    task_source: {
      kind: "manual_pilot",
      source_id: `pilot-${jobId}`,
    },
    instruction_ref: {
      kind: "control_room_task",
      instruction_id: `instruction-${jobId}`,
    },
    task_class: "coding",
    safety_class: "unprivileged",
    priority: options.priority ?? "low",
    harness: "mock",
    requested_model: "deterministic-mock-v1",
    reasoning_level: "low",
    worker_class: "homelab-pilot",
    max_runtime_seconds: options.maxRuntimeSeconds ?? 30,
    retry_policy: {
      max_attempts: options.maxAttempts ?? 3,
      backoff_initial_seconds: 1,
      backoff_max_seconds: 2,
      retryable_exit_codes: [75],
    },
    concurrency_key: workspaceKey,
    idempotency_key: options.idempotencyKey ?? `effect-${jobId}`,
    correlation_id: options.correlationId ?? randomUUID(),
  });

  return mockAgentRequestSchema.parse({
    job,
    mock: {
      scenario: options.scenario ?? "success",
      duration_ms: options.durationMs ?? 25,
      fail_until_attempt: options.failUntilAttempt ?? 0,
    },
  });
}
