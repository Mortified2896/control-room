import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentExecutionError, WorkspaceBusyError } from "./agent-adapter";
import { buildMockSubprocessInvocation, MockAgentAdapter } from "./mock-agent-adapter";
import { createPilotMockRequest } from "./pilot-job";
import { WorkspaceLeaseManager } from "./workspace-lease";

const signal = new AbortController().signal;

async function withAdapter(
  run: (adapter: MockAgentAdapter, stateDirectory: string) => Promise<void>,
): Promise<void> {
  const stateDirectory = await mkdtemp(join(tmpdir(), "control-room-hatchet-adapter-"));
  try {
    await run(new MockAgentAdapter({ stateDirectory, terminationGraceMs: 250 }), stateDirectory);
  } finally {
    await rm(stateDirectory, { recursive: true });
  }
}

test("mock adapter returns a structured success result", async () => {
  await withAdapter(async (adapter) => {
    const request = createPilotMockRequest({ scenario: "success" });
    const result = await adapter.execute(request, { attempt: 1, worker_id: "test-worker", signal });

    assert.equal(result.job_id, request.job.job_id);
    assert.equal(result.status, "succeeded");
    assert.equal(result.exit_code, 0);
    assert.match(result.execution_id, /^[0-9a-f-]{36}$/);
  });
});

test("mock adapter classifies transient failure and succeeds on retry", async () => {
  await withAdapter(async (adapter) => {
    const request = createPilotMockRequest({
      scenario: "transient_failure",
      failUntilAttempt: 1,
    });

    await assert.rejects(
      adapter.execute(request, { attempt: 1, worker_id: "test-worker", signal }),
      (error: unknown) =>
        error instanceof AgentExecutionError &&
        error.retryable &&
        error.code === "mock_transient_failure",
    );
    const result = await adapter.execute(request, {
      attempt: 2,
      worker_id: "test-worker",
      signal,
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.attempt, 2);
  });
});

test("mock adapter classifies permanent failure as non-retryable", async () => {
  await withAdapter(async (adapter) => {
    const request = createPilotMockRequest({ scenario: "permanent_failure" });
    await assert.rejects(
      adapter.execute(request, { attempt: 1, worker_id: "test-worker", signal }),
      (error: unknown) =>
        error instanceof AgentExecutionError &&
        !error.retryable &&
        error.code === "mock_permanent_failure",
    );
  });
});

test("mock adapter enforces runtime and terminates the child process", async () => {
  await withAdapter(async (adapter, stateDirectory) => {
    const request = createPilotMockRequest({
      scenario: "long_running",
      durationMs: 5_000,
      maxRuntimeSeconds: 1,
    });
    await assert.rejects(
      adapter.execute(request, { attempt: 1, worker_id: "test-worker", signal }),
      (error: unknown) => error instanceof AgentExecutionError && error.code === "timeout",
    );
    assert.match(await readOnlyEventLog(stateDirectory), /"kind":"terminated"/);
  });
});

test("mock adapter propagates cancellation into the child process", async () => {
  await withAdapter(async (adapter, stateDirectory) => {
    const request = createPilotMockRequest({ scenario: "long_running", durationMs: 5_000 });
    const controller = new AbortController();
    const execution = adapter.execute(request, {
      attempt: 1,
      worker_id: "test-worker",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 150);

    await assert.rejects(
      execution,
      (error: unknown) => error instanceof AgentExecutionError && error.code === "cancelled",
    );
    assert.match(await readOnlyEventLog(stateDirectory), /"signal":"SIGTERM"/);
  });
});

test("pre-cancelled work never starts a child process", async () => {
  await withAdapter(async (adapter, stateDirectory) => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      adapter.execute(createPilotMockRequest(), {
        attempt: 1,
        worker_id: "test-worker",
        signal: controller.signal,
      }),
      (error: unknown) => error instanceof AgentExecutionError && error.code === "cancelled",
    );
    await assert.rejects(readdir(join(stateDirectory, "events")), { code: "ENOENT" });
  });
});

test("effect ledger deduplicates a repeated delivery", async () => {
  await withAdapter(async (adapter) => {
    const request = createPilotMockRequest();
    const first = await adapter.execute(request, { attempt: 1, worker_id: "worker-a", signal });
    const second = await adapter.execute(request, { attempt: 2, worker_id: "worker-b", signal });

    assert.equal(first.status, "succeeded");
    assert.equal(second.status, "deduplicated");
    assert.equal(first.effect_id, second.effect_id);
  });
});

test("an orphaned effect candidate cannot wedge later delivery", async () => {
  await withAdapter(async (adapter, stateDirectory) => {
    const request = createPilotMockRequest();
    const effectId = createHash("sha256").update(request.job.idempotency_key).digest("hex");
    const effectsDirectory = join(stateDirectory, "effects");
    await mkdir(effectsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(effectsDirectory, effectId + ".orphan.candidate"), "", {
      mode: 0o600,
    });

    const result = await adapter.execute(request, {
      attempt: 1,
      worker_id: "worker-a",
      signal,
    });
    const record = JSON.parse(
      await readFile(join(effectsDirectory, effectId + ".json"), "utf8"),
    ) as { effect_id: string; job_id: string };

    assert.equal(result.status, "succeeded");
    assert.equal(record.effect_id, effectId);
    assert.equal(record.job_id, request.job.job_id);
  });
});

test("workspace lease blocks concurrent mutation of one workspace", async () => {
  await withAdapter(async (adapter) => {
    const workspaceKey = "shared-workspace";
    const first = adapter.execute(createPilotMockRequest({ workspaceKey, durationMs: 500 }), {
      attempt: 1,
      worker_id: "worker-a",
      signal,
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));

    await assert.rejects(
      adapter.execute(createPilotMockRequest({ workspaceKey }), {
        attempt: 1,
        worker_id: "worker-b",
        signal,
      }),
      WorkspaceBusyError,
    );
    await first;
  });
});

test("workspace lease quarantines stale missing and malformed owners", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "control-room-hatchet-lease-"));
  const root = join(stateDirectory, "leases");
  try {
    for (const [workspaceKey, owner] of [
      ["missing-owner", undefined],
      ["malformed-owner", "{not-json"],
    ] as const) {
      const name = createHash("sha256").update(workspaceKey).digest("hex") + ".lock";
      const leaseDirectory = join(root, name);
      await mkdir(leaseDirectory, { recursive: true, mode: 0o700 });
      if (owner) await writeFile(join(leaseDirectory, "owner.json"), owner, { mode: 0o600 });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

      const manager = new WorkspaceLeaseManager({
        root,
        staleAfterMs: 5,
        heartbeatMs: 1_000,
      });
      const lease = await manager.acquire(workspaceKey);
      await lease.release();
    }
  } finally {
    await rm(stateDirectory, { recursive: true });
  }
});

test("distinct workspaces can execute concurrently", async () => {
  await withAdapter(async (adapter) => {
    const [first, second] = await Promise.all([
      adapter.execute(createPilotMockRequest({ workspaceKey: "workspace-a", durationMs: 400 }), {
        attempt: 1,
        worker_id: "worker-a",
        signal,
      }),
      adapter.execute(createPilotMockRequest({ workspaceKey: "workspace-b", durationMs: 400 }), {
        attempt: 1,
        worker_id: "worker-b",
        signal,
      }),
    ]);

    assert.ok(Date.parse(first.started_at) < Date.parse(second.finished_at));
    assert.ok(Date.parse(second.started_at) < Date.parse(first.finished_at));
  });
});

test("subprocess invocation has fixed arguments, no shell, and no inherited secrets", () => {
  process.env.HATCHET_CLIENT_TOKEN = "must-not-leak";
  const invocation = buildMockSubprocessInvocation({ stateDirectory: tmpdir() });

  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.args.slice(1), ["--protocol", "stdio-v1"]);
  assert.equal(JSON.stringify(invocation).includes("must-not-leak"), false);
  assert.deepEqual(Object.keys(invocation.options.env).sort(), [
    "CONTROL_ROOM_MOCK_STATE_DIR",
    "LANG",
    "NODE_ENV",
  ]);
  delete process.env.HATCHET_CLIENT_TOKEN;
});

async function readOnlyEventLog(stateDirectory: string): Promise<string> {
  const eventFiles = await readdir(join(stateDirectory, "events"));
  assert.equal(eventFiles.length, 1);
  return readFile(join(stateDirectory, "events", eventFiles[0]), "utf8");
}
