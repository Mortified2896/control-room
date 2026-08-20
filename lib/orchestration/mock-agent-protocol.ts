import { z } from "zod";

import { controlRoomAgentJobSchema } from "./job-contract";

export const mockScenarioSchema = z.enum([
  "success",
  "transient_failure",
  "permanent_failure",
  "long_running",
  "commit_then_wait",
]);

export const mockAgentRequestSchema = z
  .object({
    job: controlRoomAgentJobSchema,
    mock: z
      .object({
        scenario: mockScenarioSchema,
        duration_ms: z.number().int().min(0).max(120_000),
        fail_until_attempt: z.number().int().min(0).max(2).default(0),
      })
      .strict(),
  })
  .strict();

export type MockAgentRequest = z.infer<typeof mockAgentRequestSchema>;

export const mockChildResultSchema = z
  .object({
    protocol_version: z.literal(1),
    execution_id: z.uuid(),
    effect_id: z.string().min(1).max(128),
    status: z.enum(["succeeded", "deduplicated"]),
    started_at: z.iso.datetime({ offset: true }),
    finished_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export type MockChildResult = z.infer<typeof mockChildResultSchema>;
