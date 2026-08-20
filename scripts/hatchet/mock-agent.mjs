#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { appendFile, link, mkdir, open, readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const RESULT_PREFIX = "CONTROL_ROOM_MOCK_RESULT ";
const MAX_INPUT_BYTES = 64 * 1024;

if (
  process.argv.length !== 4 ||
  process.argv[2] !== "--protocol" ||
  process.argv[3] !== "stdio-v1"
) {
  process.exitCode = 64;
  throw new Error("unsupported mock-agent invocation");
}

const stateDirectory = process.env.CONTROL_ROOM_MOCK_STATE_DIR;
if (!stateDirectory || !isAbsolute(stateDirectory)) {
  process.exitCode = 64;
  throw new Error("CONTROL_ROOM_MOCK_STATE_DIR must be an absolute path");
}

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES) {
    process.exitCode = 64;
    throw new Error("mock request exceeded the protocol limit");
  }
}

const request = JSON.parse(input);
validateRequest(request);

const executionId = randomUUID();
const startedAt = new Date().toISOString();
const effectId = createHash("sha256").update(request.job.idempotency_key).digest("hex");
const effectsDirectory = join(stateDirectory, "effects");
const eventsDirectory = join(stateDirectory, "events");
const eventPath = join(
  eventsDirectory,
  `${createHash("sha256").update(request.job.job_id).digest("hex")}.jsonl`,
);

await mkdir(effectsDirectory, { recursive: true, mode: 0o700 });
await mkdir(eventsDirectory, { recursive: true, mode: 0o700 });

const event = async (kind, extra = {}) => {
  await appendFile(
    eventPath,
    `${JSON.stringify({
      kind,
      at: new Date().toISOString(),
      execution_id: executionId,
      job_id: request.job.job_id,
      attempt: request.execution.attempt,
      worker_id: request.execution.worker_id,
      hatchet_run_id: request.execution.hatchet_run_id,
      ...extra,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
};

let terminating = false;
const terminate = async (signal) => {
  if (terminating) return;
  terminating = true;
  await event("terminated", { signal }).catch(() => undefined);
  process.exit(signal === "SIGTERM" ? 143 : 130);
};
process.on("SIGTERM", () => void terminate("SIGTERM"));
process.on("SIGINT", () => void terminate("SIGINT"));

await event("started", { scenario: request.mock.scenario });

if (
  request.mock.scenario === "transient_failure" &&
  request.execution.attempt <= request.mock.fail_until_attempt
) {
  await delay(request.mock.duration_ms);
  await event("failed", { failure_code: "transient" });
  process.exit(75);
}

if (request.mock.scenario === "permanent_failure") {
  await delay(request.mock.duration_ms);
  await event("failed", { failure_code: "permanent" });
  process.exit(64);
}

let effectStatus;
if (request.mock.scenario === "commit_then_wait") {
  effectStatus = await createEffect();
  if (effectStatus === "deduplicated") {
    await finish(effectStatus);
  }
  await delay(request.mock.duration_ms);
} else {
  await delay(request.mock.duration_ms);
  effectStatus = await createEffect();
}

await finish(effectStatus);

async function createEffect() {
  const effectPath = join(effectsDirectory, effectId + ".json");
  const candidatePath = join(effectsDirectory, effectId + "." + executionId + ".candidate");
  const record = {
    effect_id: effectId,
    job_id: request.job.job_id,
    execution_id: executionId,
    created_at: new Date().toISOString(),
  };

  const handle = await open(candidatePath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(record) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    try {
      await link(candidatePath, effectPath);
      await syncDirectory(effectsDirectory);
      await event("effect_committed", { effect_id: effectId });
      return "succeeded";
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      const prior = JSON.parse(await readFile(effectPath, "utf8"));
      if (prior.effect_id !== effectId || prior.job_id !== request.job.job_id) {
        throw new Error("effect ledger record failed validation");
      }
      await event("effect_deduplicated", { effect_id: effectId });
      return "deduplicated";
    }
  } finally {
    await rm(candidatePath, { force: true });
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function finish(status) {
  const finishedAt = new Date().toISOString();
  await event("finished", { status, effect_id: effectId });
  process.stdout.write(
    `${RESULT_PREFIX}${JSON.stringify({
      protocol_version: 1,
      execution_id: executionId,
      effect_id: effectId,
      status,
      started_at: startedAt,
      finished_at: finishedAt,
    })}\n`,
  );
  process.exit(0);
}

function validateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid request");
  if (!value.job || value.job.harness !== "mock") throw new Error("invalid job");
  if (typeof value.job.job_id !== "string" || typeof value.job.idempotency_key !== "string") {
    throw new Error("invalid job identifiers");
  }
  if (!value.mock || !Number.isInteger(value.mock.duration_ms))
    throw new Error("invalid mock options");
  if (!value.execution || !Number.isInteger(value.execution.attempt)) {
    throw new Error("invalid execution context");
  }
  const scenarios = new Set([
    "success",
    "transient_failure",
    "permanent_failure",
    "long_running",
    "commit_then_wait",
  ]);
  if (!scenarios.has(value.mock.scenario)) throw new Error("invalid scenario");
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
