# Control Room Roadmap

_Last updated: 2026-08-18_

## Goal

Turn real Omnigent coding tasks into reproducible benchmarks that can later answer:

- Would another coding harness have solved the same task better?
- Would another model have solved the same task better?
- Which harness × model combinations work best for particular classes of coding tasks?
- Can those results eventually improve OmniRoute routing decisions?

The key requirement is **genuine replay from the same starting state**, not merely rescoring an old trace.

## Telemetry and reproducibility

- OpenTelemetry is the preferred common vendor-neutral capture/transport foundation and the primary telemetry path.
- Preserve a bounded raw OTLP archive independently of MLflow or any other analytics vendor so downstream outages do not cause telemetry loss.
- The Mac Codex pilot captures logs, traces, and metrics into a bounded lean OTLP archive plus a short forensic trace tier. Its 60-day/50 GB retention policy is Mac-pilot-specific, not a server/O1/O2 default.
- MLflow remains an optional downstream trace, experiment, and evaluation consumer rather than the owner of canonical telemetry.
- OpenObserve may later provide a lightweight query/UI layer over reconciled telemetry.
- Server OTel should use the same persistent node/source identity convention so Mac Codex and server Omnigent telemetry can coexist and be reconciled without rewriting native trace or span IDs.
- Daytona remains the reproducible workspace/snapshot layer. Harbor and Inspect remain later evaluation and replay layers.

---

## Target architecture

```text
Production

Omnigent
   │
   ├── OmniRoute ──► models
   │
   └── OpenTelemetry ──► bounded raw OTLP archive
                         │
                         ├──► optional MLflow
                         └──► optional later query/eval consumers

Replay / evaluation

selected Omnigent task
        │
        ▼
Daytona sandbox
        │
        ├── snapshot BEFORE agent work
        │
        ▼
original execution
        │
        └── snapshot/task IDs linked by correlation metadata
            to the corresponding OTel trace and optional downstream records

later

Daytona snapshot
        │
        ├── fork → Pi
        ├── fork → Codex
        ├── fork → Claude Code
        └── fork → OpenCode
                  │
                  ▼
                Harbor
        task/verifier/results layer
                  │
                  ▼
                Inspect
       controlled experiment layer
                  │
                  ▼
             benchmark data
                  │
                  ▼
              OmniRoute
       future empirical routing evidence
```

## Responsibility split

### OpenTelemetry

Primary production telemetry capture and transport layer.

Use it for:

- traces, logs, and metrics where supported and useful
- native trace/span identifiers
- session/task correlation metadata
- harness and model metadata
- requested vs. actual provider/model provenance where available
- routing/fallback metadata
- reasoning/configuration metadata
- latency, token, and cost metadata where available
- durable linkage to later replay/evaluation artifacts

Preserve bounded raw telemetry independently of downstream products. Keep prompt, tool-result, error-body, and repository-content capture disabled by default unless an explicitly reviewed research workflow requires it.

### MLflow

Optional downstream trace, experiment, and evaluation consumer.

Use it when its UI or experiment/evaluation features are useful for:

- viewing selected Omnigent traces
- comparing experiments/evaluations
- querying normalized task/model/provider metadata
- linking replay artifacts (`sandbox_id`, `snapshot_id`, later Harbor/Inspect IDs)

MLflow is not the canonical transport or raw telemetry store. An MLflow outage must not stop raw OTel capture and should not, by itself, block unrelated Omnigent operation once deployment safety gates have been decoupled appropriately.

### Daytona

Workspace/runtime reproducibility layer.

Use it for:

- disposable Omnigent execution sandboxes
- exact pre-agent workspace capture
- filesystem state including dirty and untracked files
- snapshots
- forks/clones for independent replay attempts
- sandbox/resource telemetry where useful

The important milestone is taking the snapshot **after the task workspace is prepared but before the coding agent changes anything**.

### Harbor

Benchmark task and objective verification layer.

Add Harbor when replayable tasks exist and we want durable benchmark definitions.

Use it for:

- task instruction
- environment/snapshot reference
- acceptance commands
- regression tests
- task-specific invariants
- Git/diff checks
- structured result metrics
- portable benchmark tasks

Do not invent a weighted aggregate score initially. Prefer an outcome vector such as pass/fail, tests, regressions, runtime, tokens, cost, diff size, and optional judge score.

### Inspect / Inspect SWE

Controlled experiment layer.

Add Inspect after basic replay works reliably.

Use it for:

- repeated evaluations
- parallel experiment orchestration
- harness × model matrices
- controlled model substitution under coding harnesses where supported
- retries/resume for long-running evaluations
- standardized experiment logs and comparisons

This is especially useful for answering the scientific counterfactual question: keep the task and harness fixed while changing only the underlying model.

### OmniRoute

Consumer of benchmark evidence, not an early-stage dependency.

Only use replay results for routing optimization after a meaningful corpus of trustworthy replay tasks exists.

---

# Phased plan

## Phase 0 — Stabilize OpenTelemetry capture

**Status: IN PROGRESS / current priority**

Goal: make production telemetry trustworthy and independent of downstream analytics availability before adding replay infrastructure.

### Requirements

- [ ] Raw OTel capture remains reliable during normal Omnigent use.
- [ ] Server Omnigent has a bounded raw archive analogous to the validated Mac Codex pilot.
- [ ] Low-noise span filtering remains intact where filtering is applied.
- [ ] Prompt, tool-result, error-body, and repository-content capture remain disabled by default.
- [ ] Harness identity is captured.
- [ ] Requested model is captured.
- [ ] Actual provider/model is captured where available.
- [ ] OmniRoute routing/fallback provenance is linkable to the task.
- [ ] Reasoning level/configuration is captured where available.
- [ ] Token/cost/runtime metadata is retained where available.
- [ ] Session/task identifiers are stable enough to correlate later replay artifacts.
- [ ] Storage growth is bounded by explicit size/retention policy so tracing cannot again create severe disk pressure.
- [ ] MLflow can be enabled or disabled as an optional downstream consumer without losing the canonical raw telemetry stream.

### Exit criterion

A representative Omnigent coding session produces a clean, complete, low-noise raw OTel trace/archive with enough metadata to identify what ran without storing sensitive task payloads, and downstream MLflow availability is not required for capture continuity.

---

## Phase 1 — Add Daytona execution and pre-agent snapshots

**Status: NEXT**

Goal: make future real Omnigent tasks reproducible from their exact starting state.

### Work

- [ ] Validate the existing native Omnigent → Daytona sandbox integration in the current production version.
- [ ] Decide on Daytona deployment mode suitable for the HomeLab, prioritizing self-hosted operation and low idle resource usage.
- [ ] Run one normal Omnigent coding session inside a Daytona sandbox.
- [ ] Identify the exact pre-agent boundary where the task workspace is fully prepared but no coding agent mutation has occurred.
- [ ] Add or expose a snapshot hook at that boundary if Omnigent does not already expose it.
- [ ] Store/link `sandbox_id` and `snapshot_id` with the corresponding Omnigent/OTel task/trace and optional MLflow record.
- [ ] Verify that dirty files, staged changes, unstaged changes, and untracked files survive restoration exactly.
- [ ] Validate resource limits so replay infrastructure cannot destabilize production Omnigent.

### Exit criterion

One real Omnigent task can be restored later from a Daytona snapshot with an identical starting workspace.

---

## Phase 2 — Prove genuine replay

**Status: PLANNED**

Goal: demonstrate counterfactual execution, not trace rescoring.

### Work

- [ ] Fork/clone the same pristine Daytona task state into two independent attempts.
- [ ] Verify identical initial workspace fingerprints before either agent starts.
- [ ] Replay the task with two harness configurations, initially something simple such as Pi vs. Codex.
- [ ] Use the same task instruction and acceptance commands.
- [ ] Capture resulting patches/commits, test results, duration, token usage, and cost where available.
- [ ] Confirm that one replay cannot contaminate the other.

### Exit criterion

Two independent agents start from the same state, perform the full task separately, and produce objectively comparable results.

---

## Phase 3 — Introduce Harbor benchmark tasks

**Status: PLANNED / defer until Phase 2 works**

Goal: turn successful replay captures into durable executable coding benchmarks.

### Work

- [ ] Define a minimal Control Room → Harbor task conversion.
- [ ] Reference the reproducible starting state rather than copying sensitive content into telemetry.
- [ ] Encode deterministic acceptance tests and task-specific invariants.
- [ ] Record structured metrics rather than relying primarily on an LLM judge.
- [ ] Preserve task provenance back to the original Omnigent session/OTel trace and optional downstream records.
- [ ] Test export/import portability of the resulting benchmark tasks.

### Initial result vector

Prefer metrics such as:

```text
acceptance_pass
tests_passed / tests_total
regressions
invariants_passed / invariants_total
unexpected_files
diff_lines
wall_time_sec
input_tokens
output_tokens
cost
optional_outcome_judge_score
```

### Exit criterion

A small corpus of real Omnigent tasks can be run as portable Harbor benchmarks with objective verification.

---

## Phase 4 — Add Inspect / Inspect SWE

**Status: LATER**

Goal: run controlled, systematic harness × model experiments.

### Work

- [ ] Validate Inspect against the Harbor task corpus.
- [ ] Connect model calls through OmniRoute or another controlled provider path where appropriate.
- [ ] Verify supported combinations rather than assuming every harness/model pairing works.
- [ ] Start with a small matrix and low concurrency.
- [ ] Separate two experiment modes:
  - `controlled_bridge`: vary underlying model while keeping harness/task fixed.
  - `native_product`: use each harness with its normal subscription/API/product configuration.
- [ ] Record retries/repetitions so stochastic variance can be measured.
- [ ] Export structured benchmark results for downstream analysis.

### Exit criterion

The same benchmark can be run repeatedly across multiple harness/model combinations with comparable objective outcomes.

---

## Phase 5 — Build the routing evidence corpus

**Status: FUTURE**

Goal: accumulate enough trustworthy replay evidence for analysis.

### Work

- [ ] Promote only worthwhile production tasks into the permanent replay corpus.
- [ ] Categorize tasks using features available **before execution**.
- [ ] Accumulate multiple task classes rather than overfitting to one repository/problem type.
- [ ] Track success, quality, latency, token use, and cost separately.
- [ ] Avoid premature single-score optimization.
- [ ] Periodically analyze which harness/model combinations dominate by task type and constraints.

### Suggested threshold before routing work

Do not change OmniRoute policy based on a handful of examples. Revisit routing optimization only after roughly **50–100 high-quality replay tasks**, ideally with repeated runs for important comparisons.

---

## Phase 6 — Feed evidence into OmniRoute

**Status: FUTURE / research**

Goal: use empirical counterfactual evidence to improve routing.

Conceptually:

```text
features known before execution
          │
          ▼
historical replay outcomes
          │
          ▼
P(success | task, harness, model)
+ expected quality
+ latency
+ cost
          │
          ▼
OmniRoute routing policy
```

Requirements before enabling this:

- sufficient benchmark corpus
- validated task taxonomy/features
- clear optimization objective and guardrails
- holdout evaluation demonstrating that learned routing beats current policy
- no silent provider/model fallback that breaks provenance

---

# Near-term priorities

The current order is intentionally conservative:

1. **Restore O1 and peer-supervised deployment health without destabilizing O2.**
2. **Establish reliable, bounded server-side OpenTelemetry capture independent of MLflow.**
3. **Keep MLflow optional downstream; repair or enable it only when useful for analysis/evaluation.**
4. **Add Daytona and prove pre-agent snapshot/restore.**
5. **Prove one genuine two-agent replay from the same starting state.**
6. **Only then add Harbor and Inspect, and accumulate evidence before touching OmniRoute routing policy.**

---

# Explicit non-goals for now

Do not currently:

- make MLflow the canonical telemetry transport or raw archive;
- replace the vendor-neutral OTel foundation with Langfuse;
- deploy Langfuse's heavier ClickHouse/Postgres/Redis/object-storage stack on the constrained HomeLab;
- build a custom sandbox/snapshot engine when Daytona already provides the relevant primitives and is directly supported by Omnigent;
- build a custom evaluation framework before testing Harbor;
- deploy Inspect before genuine replay itself is proven;
- capture full repository contents, prompts, tool outputs, or error bodies into telemetry by default;
- automatically retain every Omnigent task forever;
- run large 4-harness × N-model × repeated matrices on every task;
- train/modify OmniRoute routing based on a tiny early benchmark corpus.

---

# Immediate milestone

> **O1/peer-deployer healthy → bounded server Omnigent OTel capture works independently of MLflow → one Omnigent task runs in Daytona → snapshot taken at the pristine pre-agent boundary → snapshot/task identifiers linked to the OTel trace → the task can later be restored exactly.**

That milestone creates the foundation for optional MLflow analysis, Harbor, Inspect, and eventual evidence-driven OmniRoute routing without requiring those systems to own or gate canonical telemetry.
