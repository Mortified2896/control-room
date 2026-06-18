# Control Room — Postgres Persistence Plan

> Status: **Persistent chat v1 implemented and validated.**
> Last updated: 2026-06-18, Hermes VM implementation session.

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
| App env var name | `CONTROL_ROOM_DATABASE_URL` | Single URL — easier than mirroring the 4 separate `*_DB` / `*_USER` / `*_PASSWORD` / `*_HOST` vars. Standard `postgres://user:***@host:port/db` form. |

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
    echo 'CONTROL_ROOM_DATABASE_URL=postgres://control_room_app:***@127.0.0.1:5432/control_room' \
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

---

## 9. Persistent chat v1 — Status: COMPLETE (2026-06-18)

Persistent chat is now wired end-to-end with the existing `pg` + plain SQL stack. No ORM was added.

### 9.1 Final product design

**Persistent chat v1 includes:**
- DB-backed `threads`.
- DB-backed `messages`.
- History hydration when switching threads.
- Automatic sidebar title from the first user message, only when the thread title is still exactly `New chat`.

**Feedback:**
- Thumbs up/down are message-level ratings for assistant messages only.
- The UI persists/toggles ratings silently via `PUT /api/messages/:id/feedback`.
- Upsert semantics: one `message_feedback` row per assistant message.
- Clicking the same rating again deletes the row and returns `{ rating: null }`.
- No automatic note prompt, no "what was wrong?" popover, no reason chips, no forced follow-up UI.

**Notes:**
- Notes are independent thread-level metadata in `thread_notes`.
- Notes can exist with no rating; ratings can exist with no notes.
- Notes are not chat messages.
- Notes are not included in `/api/chat` model context by default.
- Future notes-as-context should be an explicit user-controlled feature; it was not built in v1.

**Model context guardrail:**
- `/api/chat` builds model input with `convertToModelMessages(messages)` using only the client-supplied actual chat `UIMessage[]`.
- It does not load or merge ratings, notes, feedback, traces, debug metadata, or routing metadata.

### 9.2 Schema and migrations

Existing `0001_init.sql` remains the base schema for:
- `threads`
- `messages`
- `message_feedback`
- `schema_migrations`

A small additive migration was added:

```sql
-- db/migrations/0002_thread_notes.sql
CREATE TABLE IF NOT EXISTS thread_notes (
  thread_id  uuid        PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  body       text        NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS thread_notes_set_updated_at ON thread_notes;
CREATE TRIGGER thread_notes_set_updated_at
  BEFORE UPDATE ON thread_notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

Migration validation:

```bash
npm run db:migrate
# [migrate] skip   0001_init.sql (already applied)
# [migrate] apply  0002_thread_notes.sql
# [migrate] ok     0002_thread_notes.sql
# [migrate] done
```

### 9.3 API/routes

Existing routes retained:
- `GET /api/threads`
- `POST /api/threads`
- `GET /api/threads/:id/messages`
- `POST /api/threads/:id/messages`
- `POST /api/chat`
- `GET /api/models`
- `GET /api/db-health`

New routes:
- `GET /api/messages/:id/feedback`
- `PUT /api/messages/:id/feedback`
- `GET /api/threads/:id/note`
- `PUT /api/threads/:id/note`

`/api/chat` persistence behavior:
- Accepts optional `threadId` in the request body.
- Persists the latest user message best-effort before/while streaming.
- Persists the assistant reply in `toUIMessageStreamResponse({ onFinish })` after completion.
- Continues streaming if persistence fails; errors are logged and not exposed as chat failures.

### 9.4 UI behavior

`app/assistant.tsx` now:
- Fetches `/api/threads` on mount.
- Creates new DB threads with `POST /api/threads`.
- Fetches `/api/threads/:id/messages` when the selected thread changes.
- Hydrates `useChatRuntime({ messages: initialMessages })` with persisted `UIMessage[]`.
- Renders one active `ChatPane`, keyed by `activeThreadId`, instead of mounting one runtime per sidebar row.
- Shows a small offline banner when DB-backed routes report `configured: false` or are unreachable.
- Includes a minimal independent thread-note editor; the placeholder and helper text state that notes are not sent to the model.

`components/assistant-ui/thread.tsx` now:
- Loads/saves assistant-message feedback silently through `/api/messages/:id/feedback`.
- Does not show note prompts, popovers, chips, or follow-up UI.

### 9.5 Validation results

Commands run:

```bash
node --test --experimental-strip-types \
  lib/assistant-ui/thread-messages.test.ts \
  lib/repo/feedback.test.ts
# 8 tests passed

npx tsc --noEmit
# clean exit 0

npm run build
# ✓ Compiled successfully
# routes include /api/messages/[id]/feedback and /api/threads/[id]/note
```

Lint status:
- `oxlint` portion of `npm run lint` is clean: 0 warnings, 0 errors.
- Touched feature files were formatted with `npx oxfmt ...` and no longer appear in the focused oxfmt check.
- Full `npm run lint` still fails on unrelated pre-existing/no-config oxfmt issues in files outside this feature set (for example `app/globals.css`, `app/layout.tsx`, and several pre-existing components/docs). This is unchanged repo-wide formatter debt, not a TypeScript or oxlint failure.

Runtime service validation:
- Verified live service via `systemctl --user status control-room.service`.
- Actual port: `127.0.0.1:18100` (not `:3000`).
- Restart initially failed because an orphaned old `next-server` still held port `18100`; killed only that orphan and restarted `control-room.service` successfully.

Smoke test results:

```text
thread_title=Reply with exactly: persistent smoke ok
message_count=2
roles=user,assistant
rating=up
note=smoke note independent from rating
```

Browser/UI smoke:
- Loaded `http://127.0.0.1:18100/`.
- Sidebar showed persisted thread `Reply with exactly: persistent smoke ok`.
- Thread history hydrated with the user prompt and assistant reply.
- Independent thread note displayed: `smoke note independent from rating`.
- Created a new thread from the UI, switched away, then switched back to the persisted thread.
- Old thread history and note hydrated again.
- Browser console showed no JavaScript errors.

### 9.6 NocoDB / inspection guidance

Do **not** connect NocoDB using `control_room_app` write credentials.

For validation, prefer `psql` first:

```bash
set -a; . /etc/hermes/control_room_postgres.env; set +a
psql "$CONTROL_ROOM_DATABASE_URL" -c "\dt"
```

If NocoDB inspection is desired later, create a separate read-only role with SELECT only on the relevant Control Room tables:

```sql
CREATE ROLE control_room_readonly LOGIN PASSWORD 'replace-with-generated-password';
GRANT CONNECT ON DATABASE control_room TO control_room_readonly;
GRANT USAGE ON SCHEMA public TO control_room_readonly;
GRANT SELECT ON TABLE threads, messages, message_feedback, thread_notes TO control_room_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO control_room_readonly;
```

Do not grant schema creation or write privileges to the read-only role. Do not touch the existing Learn Chinese NocoDB setup.
