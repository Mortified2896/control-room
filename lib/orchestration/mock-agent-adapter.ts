import { spawn } from "node:child_process";
import { resolve } from "node:path";

import {
  AgentExecutionError,
  type AgentExecutionAdapter,
  type AgentExecutionContext,
  type AgentExecutionResult,
} from "./agent-adapter";
import { parseControlRoomAgentJob } from "./job-contract";
import {
  mockAgentRequestSchema,
  mockChildResultSchema,
  type MockAgentRequest,
} from "./mock-agent-protocol";
import { WorkspaceLeaseManager } from "./workspace-lease";

const RESULT_PREFIX = "CONTROL_ROOM_MOCK_RESULT ";
const MAX_OUTPUT_BYTES = 64 * 1024;

export type MockSubprocessInvocation = {
  executable: string;
  args: string[];
  options: {
    cwd: string;
    detached: boolean;
    shell: false;
    env: NodeJS.ProcessEnv;
  };
};

export function buildMockSubprocessInvocation(options: {
  executablePath?: string;
  scriptPath?: string;
  stateDirectory: string;
}): MockSubprocessInvocation {
  const executable = options.executablePath ?? process.execPath;
  const scriptPath = options.scriptPath ?? resolve(process.cwd(), "scripts/hatchet/mock-agent.mjs");
  const stateDirectory = resolve(options.stateDirectory);

  return {
    executable,
    args: [scriptPath, "--protocol", "stdio-v1"],
    options: {
      cwd: stateDirectory,
      detached: process.platform !== "win32",
      shell: false,
      // Deliberately do not inherit process.env: it contains the Hatchet token.
      env: {
        LANG: "C.UTF-8",
        NODE_ENV: "test",
        CONTROL_ROOM_MOCK_STATE_DIR: stateDirectory,
      },
    },
  };
}

export class MockAgentAdapter implements AgentExecutionAdapter<MockAgentRequest> {
  readonly name = "mock-agent-stdio-v1";
  readonly stateDirectory: string;
  readonly invocation: MockSubprocessInvocation;
  readonly leaseManager: WorkspaceLeaseManager;
  readonly terminationGraceMs: number;

  constructor(options: {
    stateDirectory: string;
    executablePath?: string;
    scriptPath?: string;
    terminationGraceMs?: number;
    staleLeaseAfterMs?: number;
  }) {
    this.stateDirectory = resolve(options.stateDirectory);
    this.invocation = buildMockSubprocessInvocation({
      executablePath: options.executablePath,
      scriptPath: options.scriptPath,
      stateDirectory: this.stateDirectory,
    });
    this.terminationGraceMs = options.terminationGraceMs ?? 1_000;
    this.leaseManager = new WorkspaceLeaseManager({
      root: resolve(this.stateDirectory, "leases"),
      staleAfterMs: options.staleLeaseAfterMs,
    });
  }

  async execute(
    untrustedRequest: MockAgentRequest,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult> {
    const request = mockAgentRequestSchema.parse(untrustedRequest);
    const job = parseControlRoomAgentJob(request.job);

    if (job.harness !== "mock") {
      throw new AgentExecutionError({ code: "adapter_harness_mismatch", retryable: false });
    }
    if (job.safety_class === "deployment") {
      throw new AgentExecutionError({ code: "deployment_not_supported", retryable: false });
    }
    if (context.signal.aborted) {
      throw new AgentExecutionError({ code: "cancelled", retryable: false });
    }

    const lease = await this.leaseManager.acquire(job.concurrency_key);
    try {
      return await this.runChild(request, context);
    } finally {
      await lease.release();
    }
  }

  private async runChild(
    request: MockAgentRequest,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult> {
    if (context.signal.aborted) {
      throw new AgentExecutionError({ code: "cancelled", retryable: false });
    }

    const invocation = this.invocation;
    const child = spawn(invocation.executable, invocation.args, {
      ...invocation.options,
      stdio: ["pipe", "pipe", "pipe"] as const,
    });

    let abortKind: "cancelled" | "timeout" | "output_limit" | undefined;
    let output = "";
    let stderr = "";
    let forceKillTimer: NodeJS.Timeout | undefined;

    const terminate = (kind: "cancelled" | "timeout" | "output_limit") => {
      if (abortKind) return;
      abortKind = kind;
      if (!signalProcessTree(child.pid, "SIGTERM", invocation.options.detached)) {
        try {
          child.kill("SIGTERM");
        } catch {
          // The child may already have exited.
        }
      }
      forceKillTimer = setTimeout(() => {
        if (!signalProcessTree(child.pid, "SIGKILL", invocation.options.detached)) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The child may already have exited.
          }
        }
      }, this.terminationGraceMs);
      forceKillTimer.unref();
    };

    const onExternalAbort = () => terminate("cancelled");
    context.signal.addEventListener("abort", onExternalAbort, { once: true });
    if (context.signal.aborted) terminate("cancelled");

    const runtimeTimer = setTimeout(
      () => terminate("timeout"),
      request.job.max_runtime_seconds * 1_000,
    );
    runtimeTimer.unref();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output = appendBounded(output, chunk, () => terminate("output_limit"));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk, () => terminate("output_limit"));
    });

    const wireRequest = {
      ...request,
      execution: {
        attempt: context.attempt,
        worker_id: context.worker_id,
        hatchet_run_id: context.hatchet_run_id,
      },
    };

    child.stdin.end(`${JSON.stringify(wireRequest)}\n`, "utf8");

    try {
      const { code } = await new Promise<{ code: number | null }>(
        (resolvePromise, rejectPromise) => {
          child.once("error", rejectPromise);
          child.once("close", (code) => resolvePromise({ code }));
        },
      );

      if (abortKind) {
        throw new AgentExecutionError({
          code: abortKind,
          retryable: false,
          exitCode: code ?? undefined,
        });
      }

      if (code !== 0) {
        const retryable =
          code !== null && request.job.retry_policy.retryable_exit_codes.includes(code);
        throw new AgentExecutionError({
          code: retryable ? "mock_transient_failure" : "mock_permanent_failure",
          retryable,
          exitCode: code ?? undefined,
        });
      }

      const resultLine = output.split("\n").findLast((line) => line.startsWith(RESULT_PREFIX));
      if (!resultLine) {
        throw new AgentExecutionError({
          code: stderr ? "mock_result_missing_with_stderr" : "mock_result_missing",
          retryable: false,
        });
      }

      const childResult = mockChildResultSchema.parse(
        JSON.parse(resultLine.slice(RESULT_PREFIX.length)),
      );
      return {
        job_id: request.job.job_id,
        execution_id: childResult.execution_id,
        adapter: this.name,
        status: childResult.status,
        attempt: context.attempt,
        started_at: childResult.started_at,
        finished_at: childResult.finished_at,
        exit_code: 0,
        effect_id: childResult.effect_id,
        worker_id: context.worker_id,
        hatchet_run_id: context.hatchet_run_id,
      };
    } catch (error) {
      if (error instanceof AgentExecutionError) throw error;
      throw new AgentExecutionError({
        code: "mock_adapter_failure",
        retryable: false,
        cause: error,
      });
    } finally {
      clearTimeout(runtimeTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      context.signal.removeEventListener("abort", onExternalAbort);
    }
  }
}

function appendBounded(current: string, chunk: string, onOverflow: () => void): string {
  if (Buffer.byteLength(current) + Buffer.byteLength(chunk) > MAX_OUTPUT_BYTES) {
    onOverflow();
    return current;
  }
  return current + chunk;
}

function signalProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
  detached: boolean,
): boolean {
  if (!pid) return true;
  try {
    process.kill(detached ? -pid : pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return true;
    }
    return false;
  }
}
