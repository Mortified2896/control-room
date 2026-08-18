# Control Room Agent Guidelines

## Source of truth

- `docs/ROADMAP.md` is the source of truth for current Control Room architecture and phase ordering.
- If this file and the roadmap conflict, follow the roadmap.
- Read the roadmap before making architectural or infrastructure changes. Also inspect
  `README.md` and the relevant subsystem documentation before substantive work.
- Prefer evidence from the current repository and runtime over assumptions, old discussions,
  or stale instructions.

## Project purpose

Control Room is evolving into a coding-agent observability, reproducibility, replay,
evaluation, and evidence-driven routing system around Omnigent, OmniRoute, and multiple
coding harnesses. Its existing web UI is one component and prototype, not the definition of
the whole system.

The long-term goal is trustworthy evidence about which harness and model combinations work
best for classes of real coding tasks. Preserve provenance, privacy, reproducibility, and
objective verification so that evidence can eventually inform OmniRoute decisions.

## Architecture boundaries

Keep these responsibilities distinct. Do not collapse them into one product or datastore:

- OpenTelemetry records what happened during execution.
- Daytona provides reproducible workspace and environment snapshots.
- Git provides code provenance and before/after state.
- Harbor represents portable benchmark tasks and their verifiers.
- Inspect / Inspect SWE runs controlled and repeated experiments.
- OmniRoute may eventually consume trustworthy benchmark evidence for routing.

Genuine replay means starting independent attempts from the same pristine pre-agent state,
not merely rescoring historical traces. Capture or verify that state after workspace setup
and before any agent mutation, and prevent attempts from contaminating one another.

### Telemetry

- Use OpenTelemetry as the preferred vendor-neutral capture and transport foundation.
- Preserve a bounded raw OTel archive independently of analytics vendors.
- Treat MLflow as a current optional downstream trace, experiment, and evaluation consumer;
  it does not own canonical telemetry.
- OpenObserve is a possible later lightweight operational query and UI layer. Do not assume
  it is deployed.
- Langfuse is not the default Control Room tracing or evaluation backend.
- Preserve native trace and span identifiers. Link execution, routing, Git, sandbox, and
  evaluation provenance with explicit correlation metadata.

Telemetry is privacy-sensitive:

- Treat prompts, tool inputs and outputs, errors, and repository content as sensitive.
- Keep raw prompt and payload capture disabled by default.
- Never commit secrets, credentials, raw telemetry, or captured user content to Git.
- Bound telemetry storage by size and retention so observability cannot exhaust resources.
- Preserve the existing Mac Codex OTel setup documented in
  `docs/mac-codex-opentelemetry.md`; do not casually change or break its configuration,
  privacy defaults, identity scheme, or bounded archive.

### Replay and evaluation

- Use Daytona for disposable environments, pristine pre-agent snapshots, restoration, and
  independent replay forks. Do not replace it with telemetry or a custom snapshot scheme
  without an explicit roadmap decision.
- Use Git commits, diffs, and clean/dirty/untracked state to establish code provenance; do
  not assume a commit alone captures the complete starting workspace.
- Introduce Harbor when replayable tasks are ready for durable instructions, acceptance
  commands, invariants, and structured results.
- Introduce Inspect / Inspect SWE after genuine replay works, for repeatable harness × model
  experiments and controlled substitutions.
- Prefer objective outcome vectors—tests, regressions, invariants, runtime, tokens, cost,
  and diff characteristics—over premature aggregate scores.
- Do not change OmniRoute policy from a small or untrustworthy corpus. Routing is a consumer
  of validated evidence, not an early replay dependency.

## Web application conventions

These defaults apply to the Control Room web application, not automatically to every future
service or tool:

- Use Next.js App Router, React, and TypeScript for the current web app.
- Follow the existing Tailwind CSS and shadcn/ui patterns before adding new UI primitives.
- Use Assistant UI for conversational UI where it fits the product behavior.
- Use AI SDK 6 for application-level model and provider integration where appropriate.
- Use Postgres as the current primary application database when relational persistence is
  required.
- Introduce LangGraph only when a concrete workflow benefits from it; it is not a universal
  architectural requirement.
- Do not add dependencies merely to make the implementation resemble a preferred stack.
- When changing UI behavior, prefer Playwright for browser interaction and visual acceptance
  testing, alongside focused unit or integration checks where useful.

## Repository workflow

- Inspect the existing implementation before proposing or building a replacement.
- Preserve unrelated and dirty work. Never silently discard uncommitted changes.
- Use a branch or worktree for substantive changes; do not modify the default branch
  directly.
- Keep changes small enough to review and avoid unrelated cleanup or formatting churn.
- Follow current repository patterns unless the task explicitly changes them.
- Run focused tests, linters, type checks, or operational checks appropriate to the subsystem
  changed.
- Verify actual behavior where possible; a successful command exit alone is not sufficient
  evidence for runtime or UI behavior.
- Review the complete diff and use `git diff --check` before publishing.
- Commit and push completed work. Open a draft PR for substantive changes unless explicitly
  instructed otherwise.
- Do not finish a task with a dirty worktree. Every task-owned change must be committed and
  pushed or deliberately deleted; preserve unrelated useful work on an appropriate branch
  instead of stranding it locally. Delete generated or runtime artifacts and add only narrowly
  scoped ignore rules when they can recur. Confirm `git status --short` is empty at completion.

## Safety invariants

Without explicit authorization, do not:

- merge pull requests or modify the default branch;
- deploy, release, or mutate production services;
- delete branches, repositories, environments, telemetry, or user data;
- change secrets, credentials, access controls, or permissions;
- perform destructive cleanup or discard local work;
- make live Omnigent self-upgrade changes.

For any authorized live dual-Omnigent operation, the target and supervisor must be different
instances. Never allow an instance to supervise or upgrade itself. Follow the relevant
runbook rather than expanding this file with transient operational details.

## Validation expectations

Match validation depth to risk. Documentation-only changes still require link/path checks,
consistency with the roadmap and current dependencies, diff review, and clean Markdown.
Code, data, infrastructure, and UI changes require focused subsystem checks plus direct
behavior verification where practical. Record material limitations or unverified assumptions
in the PR instead of presenting them as established facts.
