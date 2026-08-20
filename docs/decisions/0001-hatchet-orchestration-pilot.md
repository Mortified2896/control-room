# ADR 0001: Pilot Hatchet as the external durable execution layer

- Status: proposed - pilot further
- Date: 2026-08-20
- Decision owner: Control Room
- Scope: ordinary coding-agent execution only

## Context

Control Room needs durable queue state for coding-agent jobs that may run unattended for minutes or
hours. Jobs must survive process and worker loss, support explicit retry, timeout, cancellation,
scheduling, priority, and shared-workspace concurrency controls, and remain observable across more
than one worker. Plain process supervision can restart a process, but it does not provide the
persisted job/run state or multi-worker assignment protocol.

The orchestrator must remain separate from the planner, Git provenance, canonical OpenTelemetry
telemetry, Daytona environments, Harbor task definitions, Inspect experiments, and OmniRoute
model selection.

## Decision

Continue a bounded Hatchet pilot. Do not adopt Hatchet for real repository or Omnigent mutation
yet.

Run Hatchet as an external private service backed by a dedicated PostgreSQL database. Keep a thin
TypeScript integration and independently supervised TypeScript workers in Control Room. Represent
a side-effecting harness execution as an ordinary task. A future durable task may coordinate
deterministic waits and ordinary child tasks, but must not directly replay nondeterministic agent,
Git, GitHub, sandbox, clock, or model effects.

Hatchet owns durable run state, queueing, assignment, retries, scheduling, timeout/cancellation
signals, supported priority, and concurrency. Control Room owns policy and the reference-only job
contract. Each adapter owns its side-effect commit point, idempotent reconciliation, child-process
lifecycle, and result normalization.

The initial self-hosted shape is Hatchet Lite plus PostgreSQL-as-queue. It is appropriate only for
development, testing, and low-volume operation. No RabbitMQ or Kubernetes is justified for this
pilot.

## Why Hatchet

The real server exercise verified persisted queue/run state, two-worker assignment, retry,
terminal failure, timeout, cooperative cancellation, one-time scheduling, same-task priority,
per-workspace serialization, distinct-workspace parallelism, worker-loss redelivery, and
reconnection after a control-plane outage. Native Hatchet OpenTelemetry propagation also linked
enqueue, producer, consumer, and adapter spans in one W3C trace.

These capabilities are materially more complete than a supervisor and materially less custom
orchestration code than a bespoke PostgreSQL job table.

## Why not adopt yet

The tested harness was deterministic and harmless. The longest drain test ran 20 seconds, not
overnight. No real repository, Daytona snapshot, harness-specific cancellation, approval flow,
or O1/O2 supervisor invariant was exercised. Hatchet provides at-least-once delivery; it cannot
make arbitrary Git, GitHub, deployment, or model effects exactly once. Worker subscription
recovery also requires an assignment probe rather than relying on process health alone.

The pilot therefore supports `PILOT FURTHER`, not `ADOPT`.

## Alternatives considered

- **systemd or another process supervisor:** useful for keeping a worker alive, but does not own
  durable job state, retry history, schedules, queue visibility, concurrency keys, or multi-worker
  assignment. It remains necessary around a promoted worker.
- **GitHub Actions:** useful for repository CI, but a poor private control plane for interactive,
  hours-long local workers, harness cancellation, HomeLab capacity, and future Daytona ownership.
- **A PostgreSQL jobs table:** keeps dependencies small but requires Control Room to implement and
  operate claiming, leases, reaping, retries, cancellation, scheduling, fairness, visibility, and
  migrations correctly.
- **Celery or BullMQ:** mature queue workers, but introduce Redis/RabbitMQ or a second runtime and
  still leave more workflow/run-state behavior to Control Room.
- **Temporal or DBOS:** credible durable-execution alternatives, but their programming and
  operational models are a larger first step than the bounded queue/execution layer required here.
  They should be revisited if Hatchet's long-running recovery or versioning model fails the next
  proof.
- **Current Omnigent execution:** a harness/executor boundary, not a durable multi-worker queue and
  policy control plane.

## Consequences and costs

Positive consequences:

- durable orchestration state is external to Next.js and worker processes;
- worker capacity can scale independently;
- retries, cancellation, scheduling, and queue state use supported primitives;
- native Hatchet IDs and trace context can join Control Room evidence.

Costs and new failure modes:

- Hatchet and a dedicated PostgreSQL database require patching, backups, retention, credentials,
  migration testing, and private network exposure;
- a control-plane or database outage delays assignment and inspection;
- SDK/server incompatibility, expired worker tokens, or a healthy-but-unsubscribed worker can stall
  work;
- worker loss can redeliver a task after external effects;
- bounded worker shutdown can intentionally kill and redeliver long jobs;
- Hatchet history contains job input/output metadata and must follow privacy and retention policy.

The tested post-job footprint was approximately 647 MiB across Hatchet Lite, PostgreSQL, the pilot
Collector, and one worker. This is a sanity sample, not a load claim.

## Promotion gates

Before real coding work, prove all of the following on the server:

1. run one real harness only inside a disposable Daytona environment restored from a verified
   pristine pre-agent snapshot;
2. enforce a separate container/UID/PID/filesystem boundary so harness code cannot read the Hatchet
   worker token or other jobs' state;
3. define and test adapter event, liveness, workspace ownership, cleanup, and reconciliation
   contracts;
4. run an hours-long cancellation, graceful-stop, forced-kill, redelivery, and subprocess-tree
   cleanup test;
5. prove Git dirty/staged/untracked provenance and an adapter-specific durable side-effect commit
   point;
6. add private TLS/auth, secret rotation, database/config backup-and-restore, bounded retention,
   supervision, and assignment-level readiness;
7. prove O1/O2 target and supervisor are distinct for any separately approved deployment-class
   workflow; deployment must not use generic ordinary-job retry;
8. re-run the exact pinned server/SDK compatibility suite before every upgrade.

Only then reconsider `ADOPT`.

## Rollback

Stop and remove only the dedicated Compose project, volumes, host state, and secret file after
explicit path/label validation. Remove the Hatchet library, worker package, scripts, Compose files,
and this documentation. No Control Room application database migration, production service, O1/O2
configuration, or canonical telemetry change is involved.

## References

- [Hatchet self-hosting](https://docs.hatchet.run/self-hosting)
- [Hatchet Lite](https://docs.hatchet.run/self-hosting/hatchet-lite)
- [Architecture and delivery guarantees](https://docs.hatchet.run/v1/architecture-and-guarantees)
- [Ordinary tasks](https://docs.hatchet.run/v1/tasks)
- [Durable task determinism](https://docs.hatchet.run/v1/durable-tasks)
- [Concurrency](https://docs.hatchet.run/v1/concurrency)
- [Cancellation](https://docs.hatchet.run/v1/cancellation)
- [OpenTelemetry](https://docs.hatchet.run/v1/opentelemetry)
- [Hatchet v0.101.27 release](https://github.com/hatchet-dev/hatchet/releases/tag/v0.101.27)
- [Pilot evidence and runbook](../hatchet-orchestration-pilot.md)
