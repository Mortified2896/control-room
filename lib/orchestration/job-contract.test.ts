import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoSensitiveKeys,
  controlRoomCorrelationMetadata,
  parseControlRoomAgentJob,
  serializeControlRoomAgentJob,
} from "./job-contract";
import { createPilotMockRequest } from "./pilot-job";

test("the pilot job contract accepts the reference-only fixture", () => {
  const { job } = createPilotMockRequest();
  assert.equal(parseControlRoomAgentJob(job).schema_version, 1);
  assert.equal(job.harness, "mock");
});

test("the job contract rejects unknown secret-bearing fields and unsafe refs", () => {
  const { job } = createPilotMockRequest();
  assert.throws(() => parseControlRoomAgentJob({ ...job, api_token: "not-allowed" }));
  assert.throws(() => parseControlRoomAgentJob({ ...job, requested_ref: "main; touch /tmp/x" }));
  assert.throws(() => assertNoSensitiveKeys({ nested: { password: "not-allowed" } }));
});

test("the job contract rejects traversal-like refs, zero trace IDs, and unsupported backoff", () => {
  const { job } = createPilotMockRequest();
  assert.throws(() => parseControlRoomAgentJob({ ...job, requested_ref: "refs/heads/../main" }));
  assert.throws(() =>
    parseControlRoomAgentJob({
      ...job,
      trace_context: {
        traceparent: "00-00000000000000000000000000000000-0000000000000001-01",
      },
    }),
  );
  assert.throws(() =>
    parseControlRoomAgentJob({
      ...job,
      retry_policy: { ...job.retry_policy, backoff_max_seconds: 30 },
    }),
  );
});

test("repository mutation jobs cannot bypass their workspace concurrency key", () => {
  const { job } = createPilotMockRequest();
  assert.throws(() =>
    parseControlRoomAgentJob({
      ...job,
      concurrency_key: "a-different-workspace",
    }),
  );
});

test("serialized jobs contain references, not prompt, command, environment, or token fields", () => {
  const { job } = createPilotMockRequest();
  const serialized = serializeControlRoomAgentJob(job);
  for (const forbidden of ["prompt", "command", "environment", "token", "password"]) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false);
  }
  assert.match(serialized, /instruction_ref/);
});

test("correlation metadata is bounded and privacy-safe", () => {
  const { job } = createPilotMockRequest();
  const metadata = controlRoomCorrelationMetadata(job);

  assert.equal(metadata["control_room.job_id"], job.job_id);
  assert.equal(metadata["control_room.repository_id"], job.repository.repository_id);
  assert.equal(metadata["control_room.requested_ref"], job.requested_ref);
  assert.equal("instruction_ref" in metadata, false);
  assert.equal("task_source" in metadata, false);
});
