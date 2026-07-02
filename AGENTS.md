# AGENTS.md — Control Room

This file is the source of truth for stack defaults and non-negotiable
constraints. Anything not on the **Approved defaults** list below requires
explicit approval before it lands in the repo.

If you are an AI agent or a human contributor, read this first.

---

## Approved defaults

Control Room is built on the following stack. Use these unless a task
explicitly calls for something else and that something else has been approved.

| Layer            | Default                                                             |
| ---------------- | ------------------------------------------------------------------- |
| Framework        | **Next.js** (App Router)                                            |
| UI runtime       | **React**                                                           |
| Language         | **TypeScript** (strict)                                             |
| Styling          | **Tailwind CSS**                                                    |
| Components       | **shadcn/ui** (Radix-based primitives, registered in this repo)     |
| Chat UI          | **Assistant UI** (`@assistant-ui/react`)                            |
| Model SDK        | **AI SDK 6** (`ai`, `@ai-sdk/openai`, `@assistant-ui/react-ai-sdk`) |
| Agent runtime    | **LangGraph**                                                       |
| Observability    | **Langfuse**                                                        |
| End-to-end tests | **Playwright**                                                      |

If you are about to reach for something outside this list, stop and get
approval first — see "What requires approval" below.

---

## Agent routing rules

All assistant traffic in Control Room flows through a **lightweight LangGraph
router**. This is a hard architectural rule, not a suggestion.

- **Simple chat** → routed through LangGraph, then streamed back to the
  client via **AI SDK 6** (using `@assistant-ui/react-ai-sdk` on the UI side).
- **Complex / multi-step tasks** → routed to dedicated **LangGraph
  workflows** (state machines, tool calls, branching, retries).
- The router is the single entry point. New chat surfaces, new assistants,
  and new automations must plug into it rather than calling a model directly.

When implementing a new flow, the question to ask first is:

> _Is this a simple chat turn or a multi-step workflow?_

- Simple chat → LangGraph router node → AI SDK 6 stream → Assistant UI.
- Multi-step → LangGraph graph with explicit state and nodes.

### Model routing semantics

Hard rule: Control Room must never use deterministic routing to select the
execution model. Router/recommender models and their fallbacks are decision
engines only; they are not default execution models for the user's prompt.
Deterministic metadata such as prompt/context length may choose only the
recommender lane (default pair vs long-prompt pair), and the selected
recommender engine must still choose the execution model from authorized
candidates.

Before changing model routing, recommender, coding harness recommendation, or
router settings code, read and follow
`docs/model-routing-semantics.md`, especially the section titled
“Model Routing Semantics: Router Engines vs Execution Models”.

---

## What requires approval (do not introduce)

The following are **not** part of the stack. Do not add them, swap them in,
or propose them as alternatives without explicit, written approval from the
project owner:

- **Redis** (no in-memory cache / pub-sub layer)
- **Kafka** (no message bus)
- **Kubernetes** (no container orchestration in this repo)
- **Temporal** (no workflow engine outside LangGraph)
- **LangSmith** (observability is **Langfuse**)
- **LangFlow** (no visual / low-code agent builder)
- **Separate vector databases** (no Pinecone, Weaviate, Qdrant, Chroma, etc.)
- **Custom chat frameworks** (no bespoke agent loop — use LangGraph)
- **Custom component libraries** (no in-house primitives where shadcn/ui /
  Radix covers the need)
- **Custom LLM JSON plumbing** (no hand-rolled tool-call / structured-output
  formats — use AI SDK 6's tool/structured-output primitives)
- A **second Postgres** client, **ORM** (Prisma, Drizzle, TypeORM, …), or any
  **new primary database** — see `docs/database.md`

When in doubt, the answer is _ask first_, not _add it and see_.

---

## Conventions

- Server-only modules start with `import "server-only";`.
- Postgres access goes through `lib/db.ts` helpers — never instantiate a
  second `Pool`. See `docs/database.md`.
- Migrations are append-only `.sql` files under `db/migrations/`. Apply with
  `npm run db:migrate`. Never edit an already-applied migration.
- Keep secrets out of `.env.example` — it is a placeholder file committed to
  the repo. Real credentials live in `/etc/hermes/control_room_postgres.env`
  (or equivalent).

## Build tracing convention

Turbopack/NFT output tracing can warn with `Encountered unexpected file in NFT list`
when server code performs dynamic filesystem probes for external runtime paths
(for example locating an installed CLI binary). These probes can make the tracer
conservatively include too much of the project.

Accepted fix: use targeted `/* turbopackIgnore: true */` annotations only around
external runtime filesystem probes, as in `lib/codex/runner.ts`. Do not add broad
Turbopack/Next warning suppression unless the exact warning is understood and
documented.

Validation for tracing fixes:

```bash
npm run typecheck
npm run build
```

Confirm no Turbopack/NFT trace warning remains.

## Production safety

After API route, migration, env, or server-side changes, agents must follow
`docs/production-debugging.md` before reporting the live website as fixed. A
successful build is not enough. The deployed `next start` runtime must be
restarted with `/etc/hermes/control_room_postgres.env` loaded and JSON API
smoke checks must pass.

Client UI safety: after React/component/sidebar/layout/CSS changes, a successful
build is not enough. Agents must rebuild, ensure production was restarted with
the correct env, and verify the rendered browser UI after refresh/cache-bust. If
the screenshot still shows the old UI, assume stale runtime or stale browser
bundle before debugging React code.

## Live production deploy safety

Most website breakages happen when an agent runs `npm run build` in the live
serving repo. That mutates `.next`, while the already-running `next start`
production process may continue running against mismatched build output. A
successful build is therefore not enough; production must be restarted and
smoke-checked.

If an agent runs `npm run build` in this repo, it must immediately either:

1. run `scripts/restart-prod.sh` and then smoke-check production, or
2. stop and explicitly tell the user production may now be stale/broken, and
   provide the recovery command `scripts/restart-prod.sh`.

Agents must not run `npm run build` in the live serving directory and then leave
without restart + smoke checks or a clear warning.

For changes to `app/**`, `components/**`, `lib/**` used by routes/UI,
`next.config.*`, package/dependency/build config, API routes, or server/runtime
config, the required sequence is:

```bash
npm run typecheck
npm run build
scripts/restart-prod.sh
scripts/check-prod-stale.sh   # exit 0 = production matches the build
```

Then run smoke/render verification as applicable.

If `npm run build` was run but `scripts/restart-prod.sh` was not run, the final
report must include:

> Production state: potentially stale/broken — npm run build mutated .next, but
> production was not restarted

and include the recovery command:

```bash
scripts/restart-prod.sh
```

### Detecting a stale production build

`scripts/check-prod-stale.sh` compares the on-disk `.next/BUILD_ID` against
the `BUILD_ID` embedded in the HTML served by the running `next start`. It
exits `0` when they match and `1` when the server is still serving the
previous build (the "Live `.next` mutation hazard" — see the postmortem in
`docs/production-debugging.md` for the 2026-07-02 incident where this
mismatch rendered the live site as a blank `<div class="h-dvh"></div>`).
Always run this after `scripts/restart-prod.sh` and before claiming the live
site is fixed; never declare success when it exits non-zero.

### Build in an isolated worktree when possible

The safest pattern for validating a code change is to build in an
isolated worktree (so the live `.next` is not mutated) and only swap the
build into the live serving directory together with the restart. Use a
worktree for routine typecheck + build validation; only the final deploy
needs to touch the live `.next`. If the change is only a smoke check
(e.g. a CI run, an isolated test pass), prefer `git worktree add` and
build there.

The final report must not say “done”, “deployed”, or “working” unless this
production state risk is clearly stated.

Emergency recovery rule: if the public site does not load after agent changes,
first run `scripts/restart-prod.sh` before debugging React, Next.js routing, API
code, database state, or provider config.

Optional safer-build rule: prefer building in an isolated worktree for
validation-only builds. Only build in the live repo when prepared to immediately
restart production.

## Required change report format

For every code/docs/config change, final reports must include:

- Changed:
  - concise list of files or areas changed

- Validation:
  - exact commands/checks run
  - include pass/fail status

- Production restart:
  - `yes` or `no`
  - reason
  - if yes, say whether it used `scripts/restart-prod.sh`
  - if no, say why restart was not needed or not performed

- API smoke:
  - `pass`, `fail`, or `not needed`
  - if applicable, include the exact endpoint checks
  - for API/server/schema/env changes, `scripts/smoke-prod.sh` or equivalent JSON endpoint checks are required after restart

- Rendered UI check:
  - `pass`, `fail`, or `not needed`
  - for React/component/sidebar/layout/CSS/client changes, rendered browser verification is required after rebuild/restart/refresh/cache-bust
  - include what UI element/location was verified
  - if not performed, explicitly say so and do not claim the live UI is fixed

- Caveats:
  - known warnings, unrelated build warnings, skipped checks, or risks

Hard rule: A final report must not say or imply “live fixed”, “deployed”,
“visible”, or “working in production” unless the relevant production restart,
API smoke, and/or rendered UI checks were actually completed.

Examples:

Docs-only change:

```md
Changed:

- `docs/production-debugging.md`
- `AGENTS.md`

Validation:

- `npm run typecheck` ✅

Production restart:

- no — docs-only change; not needed

API smoke:

- not needed — no API/server/schema/env changes

Rendered UI check:

- not needed — no client UI change

Caveats:

- none
```

Client UI change not restarted yet:

```md
Changed:

- `components/assistant-ui/sidebar.tsx`

Validation:

- `npm run typecheck` ✅
- `npm run build` ✅

Production restart:

- no — restart not performed for this change

API smoke:

- not needed — no API/server/schema/env changes

Rendered UI check:

- fail/not performed — production was not restarted and browser was not refreshed/cache-busted; do not claim live UI is fixed

Caveats:

- live browser may still show the old client bundle until rebuild/restart/refresh is completed
```

API/server change after restart:

```md
Changed:

- `app/api/threads/route.ts`
- `lib/repo/threads.ts`

Validation:

- `npm run typecheck` ✅
- `npm test` ✅
- `npm run build` ✅

Production restart:

- yes — used `scripts/restart-prod.sh` from an external shell

API smoke:

- pass — `scripts/smoke-prod.sh` checked `/api/projects` and `/api/threads?projectId=null`

Rendered UI check:

- not needed — no client UI change

Caveats:

- none
```

---

## Validation ladder (read this before running tests)

Default validation depends on the **risk class** of the change. Do not
default to the full ladder for every change. The full E2E suite is
expensive and opt-in only.

### Risk classes

Pick the **lowest** class that still fits. When in doubt, escalate one
level — but never default to E or F.

#### A. Tiny UI / copy / layout / style change

Touches only `components/**` (non-route files), no prop changes, no new
selectors consumed by other code, no `data-testid` changes other than
labels.

**Default validation:**

- `npm run typecheck`

**Optional:**

- One focused Playwright spec covering the touched component, only if
  visual / UI behavior changed.

**Do NOT run by default:**

- `npm run build`
- Full E2E
- Production restart

#### B. Focused frontend behavior change

Touches `components/**` AND modifies props, hook wiring, internal state,
or a new selector consumed by another component.

**Default validation:**

- `npm run typecheck`
- Targeted unit tests if the touched logic has unit coverage
- One focused Playwright spec / check for the changed behavior

**Do NOT run by default:**

- Full E2E
- Production restart unless deployment is requested

#### C. API / routing / model-selection change

Touches `app/api/**`, `lib/router/**`, `lib/repo/**` repo functions used by
routes, or schema validation in `lib/router/schema.ts`. Does NOT change
provider / harness execution.

**Default validation:**

- `npm run typecheck`
- Targeted unit tests for the touched modules
- Focused endpoint smoke / check (a single `curl` or a focused Playwright
  request)
- Focused Playwright only if UI changed

**Optional:**

- `npm run build` only before deployment or if Next route / build
  behavior is affected

**Do NOT run by default:**

- Full E2E
- Production restart unless deployment is requested

#### D. Provider / harness execution change

Touches `lib/codex/**`, `lib/minimax/**`, `lib/harness/**`, or anything
that spawns a subprocess, hits a real provider, or executes a CLI.

**Default validation:**

- `npm run typecheck`
- Targeted unit tests
- Focused mocked API / browser validation (`page.route` mocks)
- A safe real CLI check **only if explicitly relevant**

**Hard rules:**

- No real API billing (OpenAI API key must not be charged)
- No silent fallback to API-billed providers
- `npm run build` only before deploy

#### E. Deploy / release change

Production deploy, schema migration, env var change, multi-file refactor
across `app/**` + `components/**` + `lib/**`, or any release-candidate
work.

**Default validation:**

- `npm run typecheck`
- `npm test`
- `npm run build`
- `scripts/smoke-prod.sh`
- Focused Playwright for the changed flows

**Optional but expected for releases:**

- `scripts/restart-prod.sh` only when deployment is intended and approved

#### F. Full E2E suite

**Expensive and opt-in only.** Allowed only when:

- Explicitly requested by the user, OR
- Pre-release / pre-merge gate, OR
- Broad DB / auth / session / app-shell changes, OR
- Broad provider / routing execution changes, OR
- Test-infra work itself (changing Playwright config, helpers, fixtures)

**Hard rules:**

- Never re-run repeatedly to "be safe" — if it passed once and you have
  not touched any test surface, the run is done
- Never run as the default validation for A / B / C / D changes
- If only 1–2 specs are relevant, run them via `test:e2e:focused`,
  not the full suite

### Forbidden validation patterns

Future agents (and humans) **must not**:

- Run full E2E by default for any change
- Re-run full E2E repeatedly "to be safe"
- Use `git stash` in this repo while parallel sessions may exist — branch
  instead
- Prove every unrelated E2E failure one by one — note them in the report
  and move on
- Run per-test Playwright loops that start a new Playwright process for
  each test — use `test:e2e:focused` with `-g` instead
- Restart production after every small change
- Spawn broad Explore sub-agents for concrete 2–5 file edits — use direct
  `read` / `grep` / `find`
- Run real provider generations or OpenAI API billing unless explicitly
  approved by the user
- Continue investigating unrelated E2E failures inside a feature task —
  quarantine / fix them in a separate dedicated task

### Required validation reporting format

Every final report **must** include:

- **Risk class:** `A` | `B` | `C` | `D` | `E` | `F`
- **Validation commands run:** exact commands
- **Wall-clock time per command:** if available, in seconds / minutes
- **Commands intentionally skipped:** explicit list and reason for each
- **Full E2E skipped:** yes / no (and why)
- **Production restart skipped:** yes / no (and why)
- **Pre-existing E2E failures observed:** list any seen, but **without
  investigating them further** as part of this task

---

## Pointers

- **Validation ladder reference** (full per-class detail + examples) →
  `docs/validation-ladder.md`
- **Postgres setup, env, helpers, migrations** → `docs/database.md`
- **DB incident runbook** (e.g. UUID errors) → `docs/db-uuid-error-runbook.md`
- **Postgres plan / schema history** → `docs/POSTGRES_PLAN.md`
- **Local VM dev workflow** → `docs/hermes-vm-dev-workflow.md`
- **OpenAI key troubleshooting** → `docs/openai-key-troubleshooting.md`
