import type { ControlRoomAgentJob } from "./job-contract";

export type AgentExecutionStatus = "succeeded" | "deduplicated";

export type AgentExecutionResult = {
  job_id: string;
  execution_id: string;
  adapter: string;
  status: AgentExecutionStatus;
  attempt: number;
  started_at: string;
  finished_at: string;
  exit_code: number;
  effect_id: string;
  worker_id: string;
  hatchet_run_id?: string;
  actual_model?: string;
  actual_provider?: string;
};

export type AgentExecutionContext = {
  attempt: number;
  worker_id: string;
  signal: AbortSignal;
  hatchet_run_id?: string;
};

export interface AgentExecutionAdapter<TRequest extends { job: ControlRoomAgentJob }> {
  readonly name: string;
  execute(request: TRequest, context: AgentExecutionContext): Promise<AgentExecutionResult>;
}

export class AgentExecutionError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly exitCode?: number;

  constructor(options: { code: string; retryable: boolean; exitCode?: number; cause?: unknown }) {
    super(options.code, { cause: options.cause });
    this.name = "AgentExecutionError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.exitCode = options.exitCode;
  }
}

export class WorkspaceBusyError extends AgentExecutionError {
  constructor() {
    super({ code: "workspace_busy", retryable: true });
    this.name = "WorkspaceBusyError";
  }
}
