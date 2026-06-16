# Control Room — Postgres Persistence Plan

> Status: **Plan only. No code, no DB, no env changes yet.**
> Last updated: 2026-06-16, Hermes VM inspection session.

## 0. What I verified on the Hermes VM (read-only)

- Repo path: `/home/hermes/workspace/repos/control-room` — freshly cloned from `https://github.com/Mortified2896/control-room.git`.
- Branch: `main`, in sync with `origin/main`. Working tree clean.
- `package.json` scripts: `dev`, `build`, `start`, `format`/`format:fix`, `lint`/`lint:fix`. **No `typecheck` script** — `tsc --noEmit` is the canonical typecheck.
- Dependencies installed (`node_modules` 705M, 289 packages, no Postgres-related deps yet).
- `npx tsc --noEmit` passes clean on `main` (with `OPENAI_API_KEY` set to a placeholder for the build).
- Local Postgres: PostgreSQL 15.18 (Debian), listening on `127.0.0.1:5432` only. Auth requires a password (good — not trust mode).
- Existing app-level credential pattern on this host: `/etc/hermes/<app>_postgres.env` (mode 640, owner `root:hermes`). Example: `/etc/hermes/learn_chinese_postgres.env` for the learn_chinese app. The `hermes` user can read those files via group membership.
- `OPENAI_API_KEY` is currently the only env var in `.env.example`; `.env.local` is gitignored and I have not touched it.

## 1. Current app shape (relevant to persistence)

- `app/assistant.tsx` — client component. Holds `threads` and `activeThreadId` in `useState`. Initial threads are a hardcoded array of 4. "New chat" generates a `local-<timestamp>-<n>` id. **All chat state is in-memory and per-tab-session.**
- `app/api/chat/route.ts` — server route. Streams OpenAI completions via `streamText` with `openai(modelId)`. Does **not** persist anything.
- `app/api/models/route.ts` — server route. Pure function read; no persistence.
- `lib/providers/*` — provider registry; only OpenAI is currently implemented end-to-end. `lib/providers/index.ts` has a `minimax` provider stub that's always disabled.
- `components/assistant-ui/thread.tsx` — renders messages; the `FeedbackButtons` component holds its `vote` in `useState` per message render. **No backend call, no persistence.**
- `components/assistant-ui/sidebar.tsx` — pure presentational; threads list comes from props.
- Stack: Next.js 16.x (App Router), React 19, AI SDK v6, `@assistant-ui/react` latest, TypeScript strict, no ORM yet, no DB driver.

## 2. Recommended naming (matches existing host convention)

| Thing | Value | Why |
|---|---|---|
| Database name | `control_room` | Lowercase, snake_case. Mirrors the `learn_chinese` precedent. |
| App DB user | `control_room_app` | App-level user; mirrors `learn_chinese_app`. |
| Owner/admin role | `control_room_owner` | DDL/migrations role. Mirrors a "principle of least privilege" split if we want it. **Optional for v1** — can be folded into `control_room_app` if you want a simpler setup. |
| Env file path | `/etc/hermes/control_room_postgres.env` | Same pattern as `learn_chinese_postgres.env`. Mode 640, owner `root:hermes`. The Next.js dev process can read it (the dev server runs as `hermes`). |
| App env var name | `CONTROL_ROOM_DATABASE_URL` | Single URL — easier than mirroring the 4 separate `*_DB` / `*_USER` / `*_PASSWORD` / `*_HOST` vars. Standard `postgres://user:pass@host:port/db` form. |

**Why one URL instead of four vars:** `learn_chinese_postgres.env` uses four vars because that app is configured that way; for a brand-new Node/Postgres app, a single `DATABASE_URL` is the modern convention and works natively with `pg`, `postgres.js`, and Drizzle/Kysely. We can revisit if you'd rather match the four-var shape.

## 3. Minimal schema (v1 — threads, messages, feedback)

UUID primary keys throughout. `created_at`/`updated_at` on every table. `messages.parts` stores the AI SDK v6 `UIMessage.parts` JSONB (so we can rehydrate the assistant-ui `MessagePrimitive.Parts` renderer exactly). `messages.role` covers `user | assistant | system`.

```sql
-- threads: one row per chat sidebar entry
CREATE TABLE threads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- messages: full message history for a thread, append-only
CREATE TABLE messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id     uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  parts         jsonb NOT NULL,                -- AI SDK v6 UIMessage.parts
  model_id      text,                          -- nullable: user msgs have none
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_thread_id_created_at_idx
  ON messages (thread_id, created_at);

-- message_feedback: thumbs up/down per assistant message (one vote per message)
CREATE TABLE message_feedback (
  message_id    uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  vote          smallint NOT NULL CHECK (vote IN (-1, 1)),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- updated_at trigger (one function, reusable)
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER threads_updated_at         BEFORE UPDATE ON threads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER message_feedback_updated_at BEFORE UPDATE ON message_feedback
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

Notes:
- `gen_random_uuid()` requires `pgcrypto` (or PG 13+ which has it built-in; PG 15.18 here, so fine).
- No `users`/`auth` table yet — out of scope for v1; we'll defer until you decide what auth looks like.
- No `model_runs` / `runs` / `feedback_comments` yet — the goal says "later model/run metadata", so I'm parking that.
- No `messages.parent_id`/branching yet — `thread.tsx` has a `BranchPicker` but branching creates a new assistant turn, not a separate row in v1.

## 4. Safest first coding milestone

**Milestone 0 (this session, optional)** — no code change, just verify. Already done: `tsc --noEmit` clean, no DB driver installed, env var convention chosen.

**Milestone 1 — Read-only wiring (no streaming change, no schema mutation at runtime)**

1. Add `pg` (`node-postgres`) to dependencies. Smallest, most boring choice. (Alternative: `postgres.js` if you'd prefer; happy to switch.)
2. Add `lib/db.ts`: a single `pg.Pool` that reads `CONTROL_ROOM_DATABASE_URL` from env; lazy-initialized; **never** importable from client components (mark with `import "server-only"`).
3. Add `lib/repo/threads.ts` and `lib/repo/messages.ts` with **only** read functions: `listThreads()`, `getThread(id)`, `listMessages(threadId)`. Each takes an explicit `pool` argument so we can swap in a test pool.
4. Add a server route `app/api/threads/route.ts` (GET) and `app/api/threads/[id]/messages/route.ts` (GET). The client `Assistant` component fetches them in its `useEffect`. **We do not yet remove the in-memory fallback** — if the DB is unreachable, the app still works as today.
5. Verify: `npm run lint`, `npx tsc --noEmit`, `npm run build`, and a manual `curl http://localhost:3000/api/threads` after seeding a couple of rows via `psql`.

Why this is the safest first milestone:
- No streaming response changes → no risk to OpenAI call path.
- DB is only read on the server, in a route, after a fetch — keeps the prompt-cache prefix intact (assistant-ui's per-conversation caching).
- Existing `INITIAL_THREADS` and `handleNewThread` still drive the UI; the server is a *secondary source* we can fall back from. We can flip the priority once we trust the wiring.
- No new env var is required for the app to keep starting — it just falls through to the in-memory path if `CONTROL_ROOM_DATABASE_URL` is unset.

**Milestone 2 — Write path (one direction at a time)**

- `POST /api/threads` → create thread.
- `POST /api/threads/:id/messages` → append message (called both from client after user submit *and* from server after stream completes).
- `POST /api/messages/:id/feedback` → upsert vote.

**Milestone 3 — Drop in-memory fallback** for the threads list once Milestone 1 + 2 are verified end-to-end.

## 5. Exact Mac command to create the database (no sudo from Hermes)

Pick one. The first is the cleanest; the second is the same thing run via `psql` non-interactively. **Do not run either yet — wait for your approval.**

Option A (interactive, recommended for first creation):

```bash
ssh -J proxmox-home hermes@10.10.10.80 \
  "sudo -u postgres psql -c \"
    CREATE DATABASE control_room;
    CREATE USER control_room_app WITH PASSWORD 'replace-me-with-22+-char-random';
    GRANT ALL PRIVILEGES ON DATABASE control_room TO control_room_app;
    \\c control_room
    GRANT ALL ON SCHEMA public TO control_room_app;
  \""
```

Option B (everything in one shell call from your Mac, with a generated password):

```bash
PW=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32) && \
ssh -J proxmox-home hermes@10.10.10.80 \
  "sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
    CREATE DATABASE control_room;
    CREATE USER control_room_app WITH PASSWORD '$PW';
    GRANT ALL PRIVILEGES ON DATABASE control_room TO control_room_app;
    \\\\c control_room
    GRANT ALL ON SCHEMA public TO control_room_app;
SQL
    sudo -u postgres psql -d control_room -v ON_ERROR_STOP=1 -c \"CREATE EXTENSION IF NOT EXISTS pgcrypto;\"
    echo 'CONTROL_ROOM_DATABASE_URL=postgres://control_room_app:$PW@127.0.0.1:5432/control_room' \
      | sudo tee /etc/hermes/control_room_postgres.env >/dev/null
    sudo chmod 640 /etc/hermes/control_room_postgres.env
    sudo chown root:hermes /etc/hermes/control_room_postgres.env"
```

I'll then read the URL out of `/etc/hermes/control_room_postgres.env` from the VM and pass it into the dev server via `dotenv`-style loading in `lib/db.ts` (or just `set -a; source /etc/hermes/control_room_postgres.env; set +a` before `npm run dev`).

## 6. What I will *not* touch in this milestone

- `.env.local` (per your rule).
- `/etc/hermes/learn_chinese_postgres.env` (per your rule).
- Any other `/etc/hermes/*.env` file.
- Any other Postgres database on this host.
- NocoDB / Lowcoder / Directus / Langfuse / any Hermes service config.
- The OpenAI key or the `streamText` call path.
- The `git` history (no commits, no pushes).
- The `package.json` dependencies, beyond adding `pg` (and `dotenv` only if you want me to load `/etc/hermes/control_room_postgres.env` automatically — otherwise the URL goes into `.env.local`/process env directly, mirroring the `OPENAI_API_KEY` pattern).

## 7. Open questions for you (need answers before I start)

1. **DB driver**: `pg` (node-postgres, boring) vs `postgres.js` (smaller, promise-native, faster cold start). Lean `pg` for now unless you say otherwise.
2. **Env file location**: OK to use `/etc/hermes/control_room_postgres.env` (matches `learn_chinese_postgres.env`), or do you want it inside the repo as `.env.local`?
3. **Two-role split** (owner + app) vs **one role** (`control_room_app` does DDL + DML). Lean **one role** for v1 to keep the admin command short.
4. **Naming**: `control_room` vs `control-room`? The repo dir is `control-room` (hyphen), but DB names with hyphens need quoting everywhere. Lean `control_room` (underscore).
5. **Order**: do you want me to also seed a single demo thread+message+vote after creating the DB, so `GET /api/threads` returns something non-empty on first run? Lean **no** — keep v1 boring.

---

## 8. Milestone 1 — Status: COMPLETE (2026-06-16)

Read-only Postgres wiring landed. No schema, no writes, no client UI change.

**DB created (Mac-side, by user):** `control_room` database, `control_room_app` role, env file `/etc/hermes/control_room_postgres.env` (mode 0640, root:hermes) holding `CONTROL_ROOM_DATABASE_URL`. Verified `db=control_room user=control_room_app` via `psql`.

**New code (all untracked, nothing committed):**
- `lib/db.ts` — `import "server-only"`, lazy `pg.Pool` from `CONTROL_ROOM_DATABASE_URL`, `isDbConfigured()`, `withClient()`, `withTransaction()`, `tryDb(fallback)` for read paths.
- `lib/repo/types.ts` — `ThreadRow`, `MessageRow`, `MessageRole` (JSON-safe shapes for the API).
- `lib/repo/threads.ts` — `listThreads()`, `getThread(id)`, `listMessages(threadId)`, `pingDb()`. All read-only and wrapped in `tryDb` so a missing table or DB returns the fallback.
- `app/api/db-health/route.ts` — `GET /api/db-health`. Returns `{ok, configured, version?}` with version truncated to `MAJOR.MINOR`. Never 5xx.
- `app/api/threads/route.ts` — `GET /api/threads`. Returns `{threads, configured}`. Empty list when DB is missing or unreachable.
- `app/api/threads/[id]/messages/route.ts` — `GET /api/threads/:id/messages`. 404 on missing thread, 200 with empty `messages` when DB is missing.

**Dependencies added (pinned, exact):** `pg@8.21.0` (runtime), `@types/pg@8.20.0` (dev). No other `package.json` changes.

**Validation results:**
- `npm run lint` → oxlint 0 warnings, 0 errors. `oxfmt --check` flags 12 pre-existing files unrelated to this work (no `.oxfmtrc` in repo; the existing `app/globals.css`, `app/layout.tsx`, all `components/**` are already out of oxfmt's defaults). My new files are oxfmt-clean.
- `npx tsc --noEmit` → clean exit 0.
- `npx next build` → ✓ Compiled successfully, 5 routes registered including the 3 new ones (`/api/db-health`, `/api/threads`, `/api/threads/[id]/messages`).

**Runtime smoke tests (with env file sourced via `set -a; . /etc/hermes/control_room_postgres.env; set +a`):**

| Endpoint | With env | Without env |
|---|---|---|
| `GET /api/db-health` | 200 `{"ok":true,"configured":true,"version":"15.18"}` | 200 `{"ok":false,"configured":false,"error":"CONTROL_ROOM_DATABASE_URL is not set"}` |
| `GET /api/threads` | 200 `{"threads":[],"configured":true}` (no schema yet) | 200 `{"threads":[],"configured":false}` |
| `GET /api/threads/<random-uuid>/messages` | 404 `{"error":"thread_not_found"}` | 200 `{"thread":null,"messages":[],"configured":false}` |
| `GET /api/models` (existing) | 200 | 200 |

**Not touched (per the rules):**
- `.env.local` — does not exist on disk, was not created.
- `/etc/hermes/learn_chinese_postgres.env` — untouched.
- The `learn_chinese` database — never queried.
- `app/assistant.tsx` and any client component — unchanged. The in-memory `INITIAL_THREADS` and `handleNewThread` still drive the UI.
- The `streamText` OpenAI call path — unchanged.
- No sudo from inside Hermes.
- No commits or pushes.

**Deviation from the original plan:** the DB health route is `app/api/db-health/route.ts`, not `app/api/_db-health/route.ts`. The `_` prefix is Next.js's "private folder" convention and *opts the file out of routing*. Renamed during this milestone so the route is actually reachable.

**Next (Milestone 2) — pending your go-ahead:**
- Add `threads`, `messages`, `message_feedback` tables (one-shot migration script under `db/migrations/0001_init.sql`).
- Wire `POST /api/threads`, `POST /api/threads/:id/messages`, `POST /api/messages/:id/feedback`.
- Optionally switch the client to use persisted threads (Milestone 3).
