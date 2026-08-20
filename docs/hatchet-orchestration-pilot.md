# Hatchet orchestration pilot

Date: 2026-08-20

Decision: **PILOT FURTHER**. See
[decision 0001](decisions/0001-hatchet-orchestration-pilot.md).

Hatchet materially reduces the amount of queue, retry, scheduling, concurrency, cancellation, and
worker-recovery machinery that Control Room would otherwise need to build. The pilot is not enough
to adopt it for live Omnigent work. The tested harness was deterministic and harmless, the longest
task was 20 seconds rather than hours, and no real repository or Daytona sandbox was used.

This was an explicitly authorized, isolated server exercise after `ai-control-hub` became
available. It superseded the original request's stale "server unavailable" assumption. It did not
modify O1, O2, OmniRoute, MLflow, the existing server Collector, or the unrelated older
`hatchet-poc` stack. No Hatchet Docker workload ran on the Mac.

## Architectural role

Hatchet is a candidate **external horizontal execution layer**:

```text
planner / task selector
          |
          | reference-only Control Room job
          v
Control Room policy and API
          |
          | enqueue / inspect / cancel
          v
external Hatchet service + dedicated PostgreSQL
          |
          | ordinary side-effecting task
          v
separately supervised worker
          |
          | typed adapter
          v
future harness inside Daytona isolation
```

Control Room owns job policy, task selection, approvals, provenance, and the user-facing API.
Hatchet owns durable run state, queueing, dispatch, supported scheduling/priority/concurrency,
timeouts, cancellation signals, and worker assignment. Hatchet is not the issue tracker, planner,
telemetry system, sandbox, Git provenance store, evaluator, or model router.

The Next.js process must not host a long-running worker. A future web endpoint may enqueue, inspect,
or request cancellation through a thin client, while independently supervised workers execute
tasks.

## Why the first primitive is an ordinary task

The coding-harness process is an ordinary Hatchet task. Agent execution, Git writes, GitHub calls,
sandbox provisioning, wall-clock checks, and model calls are nondeterministic external effects.
They do not belong directly in replay-sensitive durable-task code.

A later durable task may coordinate deterministic waits and ordinary child tasks. It must not make
the side-effecting harness itself replay-sensitive. Hatchet checkpoints do not make an hours-long
subprocess resume in the middle after a crash.

## Tested provenance

| Component              | Pin                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Hatchet Lite           | `v0.101.27`, image index `sha256:098f549448de860e95f79f93583dc353be3143a6bb2f6eba446b3d443e39e838` |
| TypeScript SDK         | `@@hatchet-dev/typescript-sdk@1.28.2`                                                              |
| PostgreSQL             | `17.11`, image index `sha256:e38411452a464af89e5adadb8d223bf53b898d47d6ef918b2d58c08707350449`     |
| OTel Collector Contrib | `0.159.0`, image index `sha256:1f2c54a30e713fac6b3ae77a1ec84010c2007e29ced8ec666214fc2f6739c1cc`   |
| Worker base            | Node `22.22.0` bookworm-slim, digest-pinned in the Dockerfile                                      |

The server/SDK pair is version-aligned: the Hatchet `v0.101.27` source tag declares
TypeScript SDK `1.28.2`. TypeScript was selected because Control Room owns the contract and
integration in TypeScript, its `AbortSignal` maps cleanly to subprocess cancellation, and
a Python worker would introduce a second control-plane implementation. A future Python Omnigent
process remains behind the adapter.

Hatchet Lite used PostgreSQL as both source of truth and message queue. RabbitMQ, Redis, NATS,
PgBouncer, Kubernetes, a public reverse proxy, and startup-at-boot integration were not added.

## Server topology and isolation

The Compose project is exactly `control-room-hatchet-pilot`.

- Hatchet dashboard/API: `127.0.0.1:8890`
- Hatchet gRPC: `127.0.0.1:7079`
- PostgreSQL: internal Compose network only
- pilot OTel receiver/archive: internal Compose network only
- worker: one slot; a second one-slot worker exists only during the parallelism test
- restart policy: `"no"` for this ephemeral pilot
- retention: 168 hours while the pilot is active
- Docker logs: 10 MiB x 3 files per service

The worker and Collector use read-only filesystems, non-root UID 1000, dropped capabilities,
`no-new-privileges`, bounded tmpfs, PID limits, CPU limits, and memory limits. Nothing
mounts the Docker socket. PostgreSQL has its own volume and Hatchet has a separate configuration
volume.

Host state is split before it enters containers:

- `$HATCHET_PILOT_STATE_DIR_HOST/runtime` is read-write only for the trusted mock worker
  and runner.
- `$HATCHET_PILOT_STATE_DIR_HOST/otel` is read-write only for the pilot Collector.

The launcher resolves and validates the state root, rejects broad or symlinked paths, requires an
exact pilot-specific basename, and requires mode 0700 with owner UID 1000. Long-form Compose bind
mounts set `create_host_path: false`.

The mock subprocess does not inherit the worker environment and uses fixed arguments,
`shell: false`, bounded output, and process-group termination. This is not a security
boundary for untrusted code: the child still shares a container, UID, and PID namespace with its
worker and may be able to inspect the parent through `/proc`. A real harness must run in a
separate Daytona/container/UID/PID/filesystem boundary without the Hatchet token.

## Typed job contract

`lib/orchestration/job-contract.ts` defines a strict version-1 reference-only envelope.
It contains:

- job, creation, source, instruction-reference, repository, workspace, and correlation IDs;
- a validated Git ref;
- task and safety class;
- requested harness/model/reasoning and worker class;
- priority, maximum runtime, fixed pilot retry policy, idempotency key, and concurrency key;
- optional W3C `traceparent`/`tracestate`;
- future Daytona sandbox and snapshot IDs.

Unknown fields are rejected. Secret-like keys are recursively rejected. The envelope has no
instruction body, raw prompt, repository path/content, arbitrary command/environment, credential,
or telemetry body.

Repository-mutating pilot jobs require `concurrency_key == repository.workspace_key`.
The task allows one run per key. The current registered task provides at most three attempts with
one- then two-second backoff. The handler can stop earlier from `max_attempts`. The local
adapter enforces the requested maximum runtime up to 12 hours; Hatchet supplies a 13-hour outer
guard and a 24-hour queue/schedule timeout. The pilot did not run an hours-long task, so overnight
process stability remains unverified.

`worker_class` is correlation metadata, not an enforced routing selector. Production
eligibility needs separate registered queues/tasks or a separately proven Hatchet label/affinity
policy. Deployment-class input is always rejected by the mock adapter.

## Adapter and side-effect safety

`AgentExecutionAdapter` supplies a typed start/execute boundary, execution identity,
cancellation signal, worker/run identity, structured result, and requested/actual model fields.
The mock adapter additionally demonstrates:

- strict parse before effects;
- fixed executable and argument vector;
- no shell interpolation;
- no inherited Hatchet token;
- local deadline plus Hatchet timeout;
- cooperative `SIGTERM`, then bounded `SIGKILL` for the process group;
- bounded stdout/stderr;
- workspace lease;
- structured attempt, effect, worker, and run IDs.

The current interface does not yet expose a typed event stream, heartbeat/liveness contract,
workspace ownership handle, or explicit cleanup/reconciliation result. Those belong in the next
real adapter only when Omnigent and Daytona provide tested consumers.

Delivery is **at least once**. Native Hatchet trigger idempotency blocks the tested duplicate
enqueue, but it cannot make arbitrary Git, GitHub, deployment, or model effects exactly once. The
mock writes a complete fsynced candidate record and atomically publishes it with a hard link.
A retry sees the complete final record and returns `deduplicated`. Orphan candidates do
not block future delivery. Workspace lease heartbeats are atomically replaced; missing or malformed
owners are quarantined only after the stale interval.

Each real adapter needs its own durable commit point and reconciliation rule. It must never infer
that a generic retry is safe merely because Hatchet redelivered the task.

## Verified lifecycle evidence

The final hardened standard matrix ran from `2026-08-20T00:01:58.713Z` through
`2026-08-20T00:02:21.188Z`.

| Case                | Observed result                                                                |
| ------------------- | ------------------------------------------------------------------------------ |
| Enqueue/success     | `QUEUED -> RUNNING -> COMPLETED` with structured attempt-1 output              |
| Retry               | transient exit 75 on attempt 1; completed on attempt 2                         |
| Permanent failure   | terminal `FAILED`; no unbounded retry                                          |
| Native timeout      | two-second Hatchet timeout reached `FAILED` and child termination was recorded |
| Cancellation        | terminal `CANCELLED` and child `SIGTERM` were both observed in 727 ms          |
| Same workspace      | two runs were serialized across two workers                                    |
| Distinct workspaces | two runs overlapped across two one-slot workers                                |
| Duplicate enqueue   | idempotency collision returned the original run ID                             |
| One-time schedule   | started after the requested time and completed                                 |
| Priority            | high started before low within the same task/key queue                         |

Additional failure injection:

- With no worker, run `89e3f07f...` remained `QUEUED` and then completed on
  attempt 1 when the worker started.
- Worker `SIGKILL` produced exit 137. Run `47a9dac0...` moved through
  `RUNNING -> QUEUED -> COMPLETED`; attempt 2 returned `deduplicated` with the
  same effect ID.
- During a Hatchet outage the combined worker/control-plane health check changed to unhealthy.
  After Hatchet restarted, the existing worker reconnected without a worker restart and a probe
  completed in 64,436 ms. The SDK's own health field alone does not represent subscription
  readiness, so an assignment probe remains the authoritative recovery check.
- A 20-second task received normal container `SIGTERM`. The worker drained for 14,185 ms,
  exited 0, and the run completed on attempt 1. Compose has an explicit 30-second stop grace.
  Longer tasks will be killed/redelivered after that bound rather than holding shutdown for hours.
- Healthy no-op probes had 210 ms and 411 ms from enqueue timestamp to child start. These are
  individual observations, not a throughput benchmark.

Queue/run state was inspected through Hatchet gRPC/API and the loopback dashboard. The tested
REST workflow-run status route returned 404, so the runner uses gRPC
`runs.getDetails`. A materialized one-time schedule was correlated through worker events
because `scheduled.get` returned 404 after execution. These are version-specific
compatibility cases to retain in regression tests.

## OpenTelemetry correlation and privacy

The worker supplies the existing tracer provider to Hatchet instrumentation and explicitly sets:

- `enableHatchetCollector: false`, so the SDK does not create a second exporter;
- payload and additional-metadata attributes excluded;
- a metadata-only pilot Collector with bounded rotation.

Initialization occurs before any runtime Hatchet SDK import. A static SDK import initially broke
propagation during the pilot; removing it produced the expected native W3C chain:

```text
control_room.agent_job.enqueue
  -> hatchet.run_workflow
     -> hatchet.start_step_run...
        -> control_room.agent_job.execute
```

All four spans shared the same native trace ID in the final probe and each parent span ID matched
the preceding span. The optional job `trace_context` is extracted with the standard OTel
propagator; no custom trace ID is invented.

The Collector deletes payload/additional-metadata/error attributes, clears span status messages,
and removes exception message/stacktrace attributes from span events. After deliberate failure
spans, the hardened archive contained zero occurrences of `payload`,
`additional_metadata`, `exception.message`,
`exception.stacktrace`, `prompt`, `password`,
`authorization`, or `HATCHET_CLIENT_TOKEN`, and zero non-empty span status
messages. Raw pilot telemetry is never committed.

## Resource sanity check

This is a small post-job sample, not a load test.

| Component       | Memory sample | Configured cap |
| --------------- | ------------: | -------------: |
| Hatchet Lite    |     80.85 MiB |          1 GiB |
| PostgreSQL      |     342.2 MiB |        1.5 GiB |
| pilot Collector |     98.13 MiB |        256 MiB |
| one worker      |     125.7 MiB |          1 GiB |

The combined sampled resident footprint was about 647 MiB. CPU snapshots fluctuated because
Hatchet heartbeats and PostgreSQL maintenance dominate a tiny sample; no sustained-load claim is
made. The host still reported about 8.26 GB available memory and about 101.85 GB free disk.

- final minimal worker image: 97,202,698 bytes;
- PostgreSQL volume: 79,672,191 bytes;
- Hatchet config volume: 10,522 bytes;
- complete pilot host state during testing: 553,179 bytes.

The final worker build installed 103 packages and reported zero vulnerabilities. Its dedicated
lockfile audit also reported zero production vulnerabilities. The full web application reported
four high production advisories, exactly matching the current server Control Room baseline; none
were introduced into the worker image.

## Validation

All commands ran in the fresh server worktree.

- `npm test`: 26 tests passed;
- `npm run typecheck`: passed;
- `npm run build`: passed, including Next.js production compilation and page generation;
- `oxlint`: zero warnings and zero errors;
- scoped `oxfmt --check` over every supported pilot-owned file: passed;
- full `npm run lint`: code lint passed, but the command remained nonzero because 23 files already
  present on `origin/main` fail its repository-wide formatting check; no pilot-owned file was in
  that list;
- `bash -n scripts/hatchet/pilot-stack.sh`: passed; ShellCheck was not installed on the server;
- Compose render, Collector `validate`, worker health/resource caps, and a final rebuilt-image
  assignment probe: passed;
- minimal worker `npm audit --omit=dev`: zero vulnerabilities;
- full application `npm audit --omit=dev`: four high advisories, matching the current-main
  baseline.

## Start and run

Create a mode-0600 env file outside Git from
`infra/hatchet/pilot.env.example`. Replace every placeholder. Use 32 to 128 hexadecimal
characters for the PostgreSQL password and exactly two space-separated 32-character hexadecimal
cookie values. Keep the state root pilot-specific.

As the UID-1000 service user:

```bash
export HATCHET_PILOT_ENV_FILE=/home/hermes/.config/control-room/hatchet-pilot.env
./scripts/hatchet/pilot-stack.sh prepare-state
./scripts/hatchet/pilot-stack.sh validate
./scripts/hatchet/pilot-stack.sh pull
./scripts/hatchet/pilot-stack.sh build
./scripts/hatchet/pilot-stack.sh up-control-plane
./scripts/hatchet/pilot-stack.sh bootstrap-token
./scripts/hatchet/pilot-stack.sh up
./scripts/hatchet/pilot-stack.sh run-standard
./scripts/hatchet/pilot-stack.sh status
```

`bootstrap-token` writes a tenant-scoped 24-hour token to the existing mode-0600 env
file without printing it. Re-run it after expiry while the control plane is healthy.

For dashboard access, use an SSH tunnel to the server loopback port. Do not expose the dashboard or
gRPC port publicly.

## Stop, purge, and rollback

Stop containers while retaining database/config state:

```bash
./scripts/hatchet/pilot-stack.sh down
```

The purge command first enumerates exact project-labeled containers, networks, and volumes:

```bash
HATCHET_PILOT_CONFIRM_PURGE=control-room-hatchet-pilot \
  ./scripts/hatchet/pilot-stack.sh purge
```

It never calls a global Docker prune. Host runtime/OTel state and the secret env file are outside
Compose and require a separate, explicitly reviewed removal after evidence export. Removing the
thin library, scripts, docs, and dedicated Compose project fully rolls back the repository pilot.
There is no database coupling to the Control Room application.

## Completed server teardown

After the evidence above was summarized, the exercise removed the exact
`control-room-hatchet-pilot` resources:

- five containers, the dedicated network, and both named volumes;
- the pilot-specific worker image;
- the external secret env file and 1.5 MiB final host runtime/OTel state;
- the obsolete non-Git staging copy and task-created temporary files.

The raw database, adapter events, and telemetry archive are intentionally not recoverable after
this cleanup; only the privacy-safe summarized evidence remains in Git. The upstream pinned base
images may remain in Docker's shared cache and can be reused or reclaimed independently.

Post-cleanup verification found no project-labeled container, network, volume, worker image, or
listener on ports 8890/7079. The unrelated `hatchet-poc` container IDs and healthy v0.98.9
service were unchanged. The canonical Collector on 8888 and all existing Omnigent, OmniRoute, and
OpenTelemetry services remained active. No pilot service is left running.

## Operations if promoted

Hatchet Lite is appropriate only for development, testing, and low-volume operation. A future
private server deployment needs:

- intentional admin setup and credential rotation; do not rely on quickstart credentials;
- TLS or a private authenticated network for remote workers;
- a long-lived tenant-scoped worker token from a secret manager;
- a worker supervisor and an assignment-level recovery probe;
- PostgreSQL plus Hatchet configuration-key backup as one restore set;
- short retention and independent bounds for DB history, Docker logs, adapter artifacts, and OTel;
- a snapshot before upgrades, pinned server and SDK versions, migration-log review, dashboard/API
  health, and a real workflow compatibility probe;
- separate PostgreSQL-major and Hatchet upgrades;
- restore-from-snapshot rollback rather than assuming down migrations are lossless.

Hatchet Lite runs migrations at startup. Restoring only PostgreSQL without Hatchet configuration
key material may make encrypted state unusable.

## O1/O2, Daytona, GitHub, and evaluation

Hatchet must not weaken the dual-Omnigent invariant. A future deployment job needs a separate
high-risk contract with explicit target, different supervisor, preflight, approval, commit point,
rollback, and no generic retry:

- target O1, supervisor O2; or
- target O2, supervisor O1.

Ordinary coding jobs must never receive this capability.

A future Daytona workflow is:

1. create the disposable sandbox;
2. prepare repository including dirty/staged/untracked state;
3. reach and verify the pristine pre-agent boundary;
4. snapshot and record `sandbox_id` and `snapshot_id`;
5. execute an ordinary harness child task;
6. collect the result and deterministic acceptance evidence;
7. preserve Git, OTel, Hatchet, and Daytona provenance.

Hatchet history is not a workspace snapshot.

Future GitHub ingestion remains read-only until a normalized Control Room job is approved:
issue/task -> planner -> reference-only job -> Hatchet -> worker -> sandboxed harness -> branch,
commit, and draft PR -> Control Room result. Hatchet is not the backlog selector and must not close
issues or merge PRs.

Harbor and Inspect remain after genuine replay. OmniRoute may consume only a sufficiently large,
validated evidence corpus; this pilot does not change routing policy or roadmap phase order.

## Exact next proof

Before `ADOPT`, implement one `OmnigentAgentAdapter` and run one harmless,
no-paid-API task in a disposable Daytona sandbox. Capture a verified pristine pre-agent snapshot,
execute from a fixed typed invocation, interrupt once after a defined adapter commit point, prove
safe reconciliation without duplicate Git effects, cancel a separate run within a declared SLO,
run deterministic acceptance, and join native OTel trace/span IDs with Control Room job, Hatchet
run, Git, Daytona sandbox, and snapshot IDs.

Also prove production authentication/TLS, worker supervision, assignment readiness, backup/restore,
token rotation, and a pinned upgrade/rollback. If the real adapter cannot reconcile effects,
health recovery is unacceptable, or the footprint is not acceptable, compare the same proof
against Temporal/DBOS and a minimal PostgreSQL queue before choosing.
