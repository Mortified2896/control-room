import { resolve } from "node:path";

import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  ConcurrencyLimitStrategy,
  HatchetClient,
  NonRetryableError,
  Priority,
  type Context,
} from "@hatchet-dev/typescript-sdk/v1";

import { AgentExecutionError, type AgentExecutionResult } from "../agent-adapter";
import { controlRoomCorrelationMetadata } from "../job-contract";
import { MockAgentAdapter } from "../mock-agent-adapter";
import { mockAgentRequestSchema, type MockAgentRequest } from "../mock-agent-protocol";

export const HATCHET_SERVER_VERSION = "v0.101.27";
export const HATCHET_TYPESCRIPT_SDK_VERSION = "1.28.2";
export const AGENT_JOB_TASK_NAME = "control-room-agent-job-v1";
export const TIMEOUT_PROBE_TASK_NAME = "control-room-agent-timeout-probe-v1";

if (!process.env.HATCHET_CLIENT_TOKEN) {
  throw new Error("HATCHET_CLIENT_TOKEN is required");
}

const stateDirectory = resolve(process.env.HATCHET_PILOT_STATE_DIR ?? ".hatchet-pilot/runtime");
const adapter = new MockAgentAdapter({ stateDirectory });
const tracer = trace.getTracer("control-room-hatchet-worker", HATCHET_TYPESCRIPT_SDK_VERSION);

export const hatchet = HatchetClient.init();

async function execute(
  untrustedInput: MockAgentRequest,
  context: Context<MockAgentRequest>,
): Promise<AgentExecutionResult> {
  const input = mockAgentRequestSchema.parse(untrustedInput);
  const attempt = context.retryCount() + 1;
  const runId = context.workflowRunId();

  return tracer.startActiveSpan(
    "control_room.agent_job.execute",
    {
      attributes: {
        ...controlRoomCorrelationMetadata(input.job),
        "control_room.attempt": attempt,
        "control_room.hatchet_run_id": runId,
        "control_room.worker_id": process.env.HATCHET_PILOT_WORKER_NAME ?? "pilot-worker",
      },
    },
    async (span) => {
      try {
        const result = await adapter.execute(input, {
          attempt,
          worker_id: process.env.HATCHET_PILOT_WORKER_NAME ?? "pilot-worker",
          hatchet_run_id: runId,
          signal: context.abortController.signal,
        });
        span.setAttribute("control_room.execution_id", result.execution_id);
        span.setAttribute("control_room.effect_status", result.status);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        const executionError =
          error instanceof AgentExecutionError
            ? error
            : new AgentExecutionError({
                code: "unclassified_adapter_failure",
                retryable: false,
                cause: error,
              });
        span.setAttribute("control_room.failure_code", executionError.code);
        span.setStatus({ code: SpanStatusCode.ERROR, message: executionError.code });

        if (!executionError.retryable || attempt >= input.job.retry_policy.max_attempts) {
          throw new NonRetryableError(executionError.code);
        }
        throw new Error(executionError.code);
      } finally {
        span.end();
      }
    },
  );
}

export const agentJobTask = hatchet.task<MockAgentRequest, AgentExecutionResult>({
  name: AGENT_JOB_TASK_NAME,
  version: "1",
  inputValidator: mockAgentRequestSchema,
  retries: 2,
  backoff: { factor: 2, maxSeconds: 2 },
  executionTimeout: "13h",
  scheduleTimeout: "24h",
  concurrency: {
    expression: "input.job.concurrency_key",
    maxRuns: 1,
    limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
  },
  idempotency: {
    strategy: "status",
    expression: "input.job.idempotency_key",
    fallbackTtlMs: 24 * 60 * 60 * 1_000,
  },
  fn: execute,
});

export const timeoutProbeTask = hatchet.task<MockAgentRequest, AgentExecutionResult>({
  name: TIMEOUT_PROBE_TASK_NAME,
  version: "1",
  inputValidator: mockAgentRequestSchema,
  retries: 0,
  executionTimeout: "2s",
  scheduleTimeout: "2m",
  concurrency: {
    expression: "input.job.concurrency_key",
    maxRuns: 1,
    limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
  },
  fn: execute,
});

export function priorityFor(value: MockAgentRequest["job"]["priority"]): Priority {
  if (value === "high") return Priority.HIGH;
  if (value === "medium") return Priority.MEDIUM;
  return Priority.LOW;
}
