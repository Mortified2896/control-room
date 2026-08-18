# Control Room Roadmap

_Last updated: 2026-08-08_

## Goal

Turn real Omnigent coding tasks into reproducible benchmarks that can later answer:

- Would another coding harness have solved the same task better?
- Would another model have solved the same task better?
- Which harness × model combinations work best for particular classes of coding tasks?
- Can those results eventually improve OmniRoute routing decisions?

The key requirement is **genuine replay from the same starting state**, not merely rescoring an old trace.

## Telemetry and reproducibility

- OpenTelemetry is the preferred common vendor-neutral capture/transport foundation; the first pilot captures Mac Codex logs, traces, and metrics into a bounded raw OTLP archive independently of MLflow.
- MLflow remains an optional downstream trace and evaluation consumer. Existing MLflow work is not replaced by capture.
- OpenObserve may later provide a lightweight query/UI layer over reconciled telemetry.
- A later server OTel deployment should use the same persistent node/source identity convention so Mac Codex and server Omnigent telemetry can coexist and be reconciled without rewriting native trace or span IDs.
- Daytona remains the reproducible workspace/snapshot layer. Harbor and Inspect remain later evaluation and replay layers.

---

## Target architecture

```text
Production

Omnigent
   │
   ├── OmniRoute ──► models
   │
   └── OpenTelemetry ──► MLflow
                           production observability

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
        └── snapshot/task IDs linked to MLflow

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

### MLflow

Production observability and correlation layer.

Use it for:

- Omnigent traces
- session/task IDs
- harness and model metadata
- requested vs. actual model/provider provenance
- routing/fallback metadata
- latency and token/cost information
- success/error status
- links to replay artifacts (`sandbox_id`, `snapshot_id`, later Harbor/Inspect IDs)

Do **not** turn MLflow into a repository or payload store. Preserve the current low-noise, privacy-first design and keep prompt/tool/error content disabled by default.

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

## Phase 0 — Stabilize MLflow

**Status: IN PROGRESS / current priority**

Goal: make production telemetry trustworthy before adding replay infrastructure.

### Requirements

- [ ] Traces remain reliably visible during normal Omnigent use.
- [ ] Low-noise span filtering remains intact.
- [ ] Prompt, tool-result, and error content remain disabled by default.
- [ ] Harness identity is captured.
- [ ] Requested model is captured.
- [ ] Actual provider/model is captured where available.
- [ ] OmniRoute routing/fallback provenance is linkable to the task.
- [ ] Reasoning level/configuration is captured where available.
- [ ] Token/cost/runtime metadata is retained where available.
- [ ] Session/task identifiers are stable enough to correlate later replay artifacts.
- [ ] Storage growth is monitored so tracing cannot again create severe disk pressure.

### Exit criterion

A representative Omnigent coding session produces a clean, complete, low-noise trace with enough metadata to identify what ran without storing sensitive task payloads.

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
- [ ] Store/link `sandbox_id` and `snapshot_id` with the corresponding Omnigent/MLflow task/trace.
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
- [ ] Preserve task provenance back to the original Omnigent session/MLflow trace and Daytona snapshot.
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

1. **Get MLflow production tracing fully reliable and low-noise.**
2. **Add Daytona and prove pre-agent snapshot/restore.**
3. **Prove one genuine two-agent replay from the same starting state.**
4. **Only then add Harbor for benchmark-grade task/verifier definitions.**
5. **Only then add Inspect for systematic harness × model experiments.**
6. **Accumulate evidence before touching OmniRoute routing policy.**

---

# Explicit non-goals for now

Do not currently:

- replace MLflow with Langfuse;
- deploy Langfuse's heavier ClickHouse/Postgres/Redis/object-storage stack on the constrained HomeLab;
- build a custom sandbox/snapshot engine when Daytona already provides the relevant primitives and is directly supported by Omnigent;
- build a custom evaluation framework before testing Harbor;
- deploy Inspect before genuine replay itself is proven;
- capture full repository contents, prompts, or tool outputs into MLflow by default;
- automatically retain every Omnigent task forever;
- run large 4-harness × N-model × repeated matrices on every task;
- train/modify OmniRoute routing based on a tiny early benchmark corpus.

---

# Immediate milestone

> **MLflow stable → one Omnigent task runs in Daytona → snapshot taken at the pristine pre-agent boundary → snapshot/task identifiers linked to the MLflow trace → the task can later be restored exactly.**

That milestone creates the foundation for Harbor, Inspect, and eventual evidence-driven OmniRoute routing without requiring those systems to be deployed yet.
