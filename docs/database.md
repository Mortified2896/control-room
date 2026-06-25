# Database

Control Room uses a single **Postgres** instance for all persisted state.
This document is the canonical reference for how that database is wired up.
If something here disagrees with the code, the code wins — and this file
should be updated to match.

The companion files `docs/POSTGRES_PLAN.md` (schema history / design notes)
and `docs/db-uuid-error-runbook.md` (incident playbook) are referenced where
relevant.

---

## Driver

- **`pg`** (node-postgres) — runtime dependency, currently `^8.21.0`.
- **`@types/pg`** — dev dependency, currently `8.20.0`.

No other Postgres client is in use. There is **no ORM**. Every query is a
parameterized `pg` call composed by hand. See "Hard rules" below.

---

## Connection layer — `lib/db.ts`

`lib/db.ts` is the **only** place in the app that creates a `pg.Pool`. It is
marked `import "server-only";` so importing it from a client component fails
the build.

Key properties:

- Lazy singleton `Pool`. Built on first `getPool()` call.
- Reads `process.env.CONTROL_ROOM_DATABASE_URL`. If the variable is unset or
  blank, the helpers throw or fall back (depending on which helper you call)
  — they do **not** silently connect to localhost.
- Conservative pool defaults for a low-traffic internal app:
  `max: 5`, `idleTimeoutMillis: 10_000`, `connectionTimeoutMillis: 3_000`.
- `pool.on("error", …)` logs idle-client errors but does **not** crash the
  process.

### Exported helpers

| Helper                | When to use                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `isDbConfigured()`    | Cheap, synchronous boolean — "is `CONTROL_ROOM_DATABASE_URL` set?". Use before expensive work or in handlers.                                   |
| `getPool()`           | Escape hatch — returns the lazy singleton. Prefer `withClient` / `withTransaction`.                                                             |
| `withClient(fn)`      | Run `fn` with a pooled client. Throws if DB is not configured or unreachable.                                                                   |
| `withTransaction(fn)` | Same as `withClient` but wraps `fn` in `BEGIN` / `COMMIT` / `ROLLBACK`.                                                                         |
| `tryDb(fn, fallback)` | Never throws. Returns `fallback` if the DB is unconfigured or any error occurs. Use on read paths that should keep working when the DB is down. |

**Read paths** (lists, lookups, health probes, anything the UI can render
without persisted state) should use `tryDb` so the app stays usable when the
DB is missing.

**Write paths** (creating rooms, recording feedback, persisting notes) should
use `withClient` / `withTransaction` so failures surface explicitly instead
of being silently swallowed.

A worked example of the pattern is `app/api/db-health/route.ts` —
`isDbConfigured()` for the cheap check, then `tryDb` to probe `SHOW
server_version` without ever throwing at the HTTP layer.

---

## Environment

### `CONTROL_ROOM_DATABASE_URL`

Standard `postgres://` / `postgresql://` connection string. The variable is
**not** documented in `.env.example` as a real value; that file only carries
a placeholder so contributors know it exists. Real credentials are expected
to live in **`/etc/hermes/control_room_postgres.env`**, which is sourced
before `npm run dev` (or passed via `dotenv -e … -- next dev`).

A missing `CONTROL_ROOM_DATABASE_URL` is treated as a soft failure: the
helpers degrade via `isDbConfigured()` / `tryDb` instead of crashing the
process. The first hard call (e.g. running `npm run db:migrate` without it)
will error out with a clear message.

### `.env.example`

`.env.example` is committed and must contain only placeholders. Add new
variables there when introducing them; never commit real secrets.

---

## Migrations

### Location and naming

- All migrations live in `db/migrations/` as plain `.sql` files.
- Files are applied in **lexical order** by filename, so use a numeric prefix:
  `0001_init.sql`, `0002_thread_notes.sql`, `0003_create_room.sql`, etc.
- **Append-only.** Once a migration has been applied to a database, do not
  edit it. Add a new migration that performs the change instead.

### Bookkeeping table — `schema_migrations`

The runner creates and maintains a single bookkeeping table:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)
```

Each applied migration inserts its filename here in the **same transaction**
as the schema change. If the schema change rolls back, the bookkeeping row
rolls back with it — so a partially-applied migration is impossible.

### Runner — `npm run db:migrate`

The script is `scripts/migrate.mjs` (run via the `db:migrate` npm script).
For each `.sql` file in `db/migrations/`:

1. If its filename is already in `schema_migrations`, skip it.
2. Otherwise open a transaction, run the file's SQL, insert the bookkeeping
   row, and commit. Roll back on any error.

Exit codes: `0` on success (including a no-op), `1` on any failure. The
runner never logs the DSN.

### Currently applied migrations

| File                                           | Purpose                                                                                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `db/migrations/0001_init.sql`                  | Initial schema (threads, messages, and the persisted chat foundation).                                                                    |
| `db/migrations/0002_thread_notes.sql`          | Adds per-thread note storage.                                                                                                             |
| `db/migrations/0003_create_room.sql`           | Adds the "create room" workflow tables (episodes, candidates, title candidates, etc.).                                                    |
| `db/migrations/0004_router_ab.sql`             | Router A/B mode persistence: `router_ab_sessions` (one row per prompt run) + `router_ab_feedback` (one row per session).                  |
| `db/migrations/0005_router_ab_side_b_text.sql` | Adds `side_b_text` and `side_b_latency_ms` columns to `router_ab_sessions` so the panel can re-hydrate Side B output after a page reload. |

For design notes and the reasoning behind the schema, see
`docs/POSTGRES_PLAN.md`. For UUID-related incidents, see
`docs/db-uuid-error-runbook.md`.

---

## Repo usage — `lib/repo/`

All Postgres reads and writes outside of migrations flow through
`lib/repo/`. Each module corresponds to a logical area of the schema:

- `lib/repo/threads.ts` — thread and message CRUD. Read paths use `tryDb`;
  writes throw on failure so the HTTP layer can surface the error.
- `lib/repo/feedback.ts` — message-level feedback (rating, comments).
- `lib/repo/create-room.ts` — the "create room" workflow tables introduced by
  `0003_create_room.sql` (episodes, candidates, title candidates, selection).
- `lib/repo/feedback-helpers.ts` — small helpers shared by the feedback path.
- `lib/repo/router-ab.ts` — Router A/B mode persistence (`router_ab_sessions`
  - `router_ab_feedback`). Read paths use `withClient`; writes throw on failure.
- `lib/repo/types.ts` — shared row/DTO types.

Route handlers in `app/api/**` call into these modules; they should not
import `pg` or instantiate their own clients.

> Note: `lib/platform.ts` is unrelated — it contains SSR-safe Mac / touch
> detection helpers and does not touch the database.

---

## Hard rules

These mirror `AGENTS.md` and are restated here because they apply directly
to anyone adding DB-touching code:

1. **One client.** Never instantiate a second `pg.Pool`, `pg.Client`, or any
   other Postgres driver (`postgres`, `pg-promise`, …). Go through
   `lib/db.ts`.
2. **No ORM.** Do not add Prisma, Drizzle, TypeORM, Kysely, or any query
   builder. Parameterized `pg` queries only.
3. **No new primary database.** No MySQL, SQLite, Mongo, Dynamo, etc. for
   primary state. Postgres is the source of truth.
4. **No Redis / external cache layer.** If a read is expensive, optimize the
   query or memoize in-process; do not introduce a cache server.
5. **Migrations are append-only.** Never edit a file already in
   `schema_migrations`.
6. **Append `.env.example` placeholders, never secrets.** The real
   `CONTROL_ROOM_DATABASE_URL` lives in
   `/etc/hermes/control_room_postgres.env`.

If any of the above needs to bend, get explicit approval first — per
`AGENTS.md`, this list is the default and deviations are by exception, not
by accident.
