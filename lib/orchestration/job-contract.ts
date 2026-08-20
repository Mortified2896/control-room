import { z } from "zod";

const opaqueId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, "must be an opaque identifier");

const safeRef = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/@+-]*$/, "must be a Git ref, not a path or command")
  .refine(
    (ref) =>
      !ref.includes("..") &&
      !ref.includes("@{") &&
      !ref.includes("//") &&
      !ref.endsWith("/") &&
      !ref.endsWith("."),
    "must satisfy the pilot Git-ref policy",
  );

const traceparent = z
  .string()
  .regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/, "must be a W3C traceparent")
  .refine(
    (value) =>
      value.slice(3, 35) !== "00000000000000000000000000000000" &&
      value.slice(36, 52) !== "0000000000000000",
    "trace and parent identifiers must be non-zero",
  );

export const retryPolicySchema = z
  .object({
    max_attempts: z.number().int().min(1).max(3),
    backoff_initial_seconds: z.literal(1),
    backoff_max_seconds: z.literal(2),
    retryable_exit_codes: z.array(z.number().int().min(1).max(255)).max(16),
  })
  .strict()
  .refine((policy) => policy.backoff_initial_seconds <= policy.backoff_max_seconds, {
    message: "backoff_initial_seconds must not exceed backoff_max_seconds",
  });

/**
 * The durable, planner-produced Control Room job envelope.
 *
 * It intentionally contains references and privacy-safe identifiers, never an
 * instruction body, repository path, environment, command, or credential.
 */
export const controlRoomAgentJobSchema = z
  .object({
    schema_version: z.literal(1),
    job_id: z.uuid(),
    created_at: z.iso.datetime({ offset: true }),
    repository: z
      .object({
        repository_id: opaqueId,
        workspace_key: opaqueId,
      })
      .strict(),
    requested_ref: safeRef,
    task_source: z
      .object({
        kind: z.enum(["control_room", "github_issue", "manual_pilot"]),
        source_id: opaqueId,
      })
      .strict(),
    instruction_ref: z
      .object({
        kind: z.enum(["control_room_task", "github_issue"]),
        instruction_id: opaqueId,
      })
      .strict(),
    task_class: z.enum(["coding", "recovery", "maintenance", "evaluation"]),
    safety_class: z.enum(["unprivileged", "repository_write", "deployment"]),
    priority: z.enum(["low", "medium", "high"]),
    harness: z.enum(["mock", "omnigent", "codex", "pi", "opencode", "claude"]),
    requested_model: opaqueId.optional(),
    reasoning_level: z.enum(["low", "medium", "high", "xhigh"]).optional(),
    worker_class: opaqueId,
    max_runtime_seconds: z.number().int().min(1).max(43_200),
    retry_policy: retryPolicySchema,
    concurrency_key: opaqueId,
    idempotency_key: opaqueId,
    correlation_id: z.uuid(),
    trace_context: z
      .object({
        traceparent,
        tracestate: z.string().min(1).max(512).optional(),
      })
      .strict()
      .optional(),
    sandbox_id: opaqueId.optional(),
    snapshot_id: opaqueId.optional(),
  })
  .strict()
  .superRefine((job, context) => {
    if (job.concurrency_key !== job.repository.workspace_key) {
      context.addIssue({
        code: "custom",
        path: ["concurrency_key"],
        message: "must equal repository.workspace_key for repository-mutating pilot jobs",
      });
    }

    if (job.safety_class === "deployment" && job.task_class !== "recovery") {
      context.addIssue({
        code: "custom",
        path: ["safety_class"],
        message:
          "deployment jobs require a dedicated recovery contract and are not pilot-executable",
      });
    }
  });

export type ControlRoomAgentJob = z.infer<typeof controlRoomAgentJobSchema>;

const forbiddenKey =
  /(secret|token|password|credential|api.?key|authorization|environment|command)/i;

export function assertNoSensitiveKeys(value: unknown, path = "job"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveKeys(item, `${path}[${index}]`));
    return;
  }

  if (value === null || typeof value !== "object") {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKey.test(key)) {
      throw new Error(`sensitive key is forbidden at ${path}.${key}`);
    }
    assertNoSensitiveKeys(child, `${path}.${key}`);
  }
}

export function parseControlRoomAgentJob(input: unknown): ControlRoomAgentJob {
  const job = controlRoomAgentJobSchema.parse(input);
  assertNoSensitiveKeys(job);
  return job;
}

export function serializeControlRoomAgentJob(input: unknown): string {
  return JSON.stringify(parseControlRoomAgentJob(input));
}

export function controlRoomCorrelationMetadata(job: ControlRoomAgentJob): Record<string, string> {
  return {
    "control_room.job_id": job.job_id,
    "control_room.correlation_id": job.correlation_id,
    "control_room.repository_id": job.repository.repository_id,
    "control_room.workspace_key": job.repository.workspace_key,
    "control_room.requested_ref": job.requested_ref,
    "control_room.harness": job.harness,
    "control_room.worker_class": job.worker_class,
    "control_room.task_class": job.task_class,
    "control_room.safety_class": job.safety_class,
    ...(job.requested_model ? { "control_room.requested_model": job.requested_model } : {}),
    ...(job.sandbox_id ? { "control_room.sandbox_id": job.sandbox_id } : {}),
    ...(job.snapshot_id ? { "control_room.snapshot_id": job.snapshot_id } : {}),
  };
}
