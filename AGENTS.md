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

Live build safety:
Do not run `npm run build` in the live production repo and then leave the old
`next start` process running. The build rewrites `.next` and can break the
currently served app. For API/UI/server changes, build + restart + smoke check
are one deploy operation and must be followed by `scripts/smoke-prod.sh`; UI
changes also require rendered browser verification. If an agent is running
inside a Control Room-hosted chat/session, it must not restart the Control Room
process that is hosting its own active response, and it must not run the
production build in the live serving directory unless an external restart is
immediately planned. If the agent is running externally (Pi terminal, Pi
Telegram, OpenCode terminal, Codex terminal/app, SSH, tmux, or systemd), it may
restart Control Room and should not use “active Control Room session” as a
reason to skip the deploy sequence.

Use `scripts/smoke-prod.sh` for live JSON API verification. Production restarts
must follow `docs/production-debugging.md` and should use `scripts/restart-prod.sh`
from a session that is not hosted by the Control Room process being restarted.

Do not restart Control Room from inside a Control Room-hosted chat/session if
that would kill the current response. External Pi/OpenCode/Codex/SSH/tmux/systemd
sessions may restart Control Room; the browser tab may disconnect or need
refresh, but the external worker should continue. If running externally, agents
should either perform the normal deploy sequence (`npm run db:migrate` if
needed, `npm run typecheck`, `npm test`, `npm run build`,
`scripts/restart-prod.sh`, `scripts/smoke-prod.sh`) or clearly say why they
cannot.

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
- no — not performed because this agent is running inside a Control Room-hosted chat/session; user or an external Pi/OpenCode/Codex/SSH/tmux session must run `scripts/restart-prod.sh`

API smoke:
- not needed — no API/server/schema/env changes

Rendered UI check:
- fail/not performed — production was not restarted and browser was not refreshed/cache-busted; do not claim live UI is fixed

Caveats:
- live browser may still show the old client bundle until rebuild/restart/refresh is completed
- if running from an external Pi/OpenCode/Codex/SSH/tmux session, do not use “active Control Room session” as the reason to skip restart; perform the deploy sequence or state the actual blocker
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

## Pointers

- **Postgres setup, env, helpers, migrations** → `docs/database.md`
- **DB incident runbook** (e.g. UUID errors) → `docs/db-uuid-error-runbook.md`
- **Postgres plan / schema history** → `docs/POSTGRES_PLAN.md`
- **Local VM dev workflow** → `docs/hermes-vm-dev-workflow.md`
- **OpenAI key troubleshooting** → `docs/openai-key-troubleshooting.md`
