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

Use `scripts/smoke-prod.sh` for live JSON API verification. Production restarts
must follow `docs/production-debugging.md` and should use `scripts/restart-prod.sh`
only from an external SSH/session.

Do not restart the active Control Room WebUI process from inside the running
Control Room chat/session if doing so would kill the current response. Use an
external SSH/session command, or stop and give the user the command to run.

---

## Pointers

- **Postgres setup, env, helpers, migrations** → `docs/database.md`
- **DB incident runbook** (e.g. UUID errors) → `docs/db-uuid-error-runbook.md`
- **Postgres plan / schema history** → `docs/POSTGRES_PLAN.md`
- **Local VM dev workflow** → `docs/hermes-vm-dev-workflow.md`
- **OpenAI key troubleshooting** → `docs/openai-key-troubleshooting.md`
