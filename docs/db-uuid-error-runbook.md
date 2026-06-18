# `invalid input syntax for type uuid: "1"` — recurring log fix

Recurring journal spam from `control-room.service`:

```
[db] call failed, falling back: invalid input syntax for type uuid: "1"
```

The site keeps working (the wrapper `tryDb` in `lib/db.ts` swallows the
Postgres error and returns the fallback), so the bug is invisible in the UI
and only shows up in `journalctl --user -u control-room.service -f`.

This runbook captures the root cause found on 2026-06-18, the fix, and the
sanitized probe you can re-run if it ever comes back.

## TL;DR

The stub `INITIAL_THREADS` list in `app/assistant.tsx` once contained
bare-integer ids (`"1"`, `"2"`, `"3"`, `"4"`). On every mount,
`activeThreadId` was seeded with `"1"`, and the messages-loading effect
fired `GET /api/threads/1/messages`. The handler had no UUID check, so
the string `"1"` reached Postgres against a `uuid` column, which
rejected it. The client render path looked fine because `tryDb` returned
`null` / `[]` and the catch in the messages effect silently cleared
`threadMessages`.

The stub ids were then renamed to `"local-1"`, `"local-2"`, ... so a
single `id.startsWith("local-")` check covers both the offline stubs
and the in-memory "New chat" entries, removing the need for any
numeric-shape special-casing.

Two files were touched for the fix:

1. `app/assistant.tsx` — renamed stub ids to use the `"local-"` prefix
   and switched the messages-loading guard to use the helper.
2. `app/api/threads/[id]/messages/route.ts` — added a `UUID_RE` guard to
   the GET handler so any non-UUID id is rejected with a clean 404 before
   Postgres is touched. The sibling POST handler and both note-route
   handlers already had this guard.

## How the call chain was wired

| Layer | File | Behavior before fix |
| --- | --- | --- |
| Client state seed | `app/assistant.tsx` | `useState<string \| null>(INITIAL_THREADS[0]?.id ?? null)` → `activeThreadId = "1"` |
| Client effect | `app/assistant.tsx` (≈ line 408) | Guard: `!activeThreadId.startsWith("local-")` — did **not** catch `"1"` |
| API handler | `app/api/threads/[id]/messages/route.ts` GET | No `UUID_RE` guard; passed `id` straight to `getThread(id)` / `listMessages(id)` |
| Repo wrapper | `lib/repo/threads.ts` (`getThread`, `listMessages`) | Uses `tryDb(fn, fallback)` so the error is logged and swallowed |
| Postgres | `threads.id uuid`, `messages.thread_id uuid` | Rejects `"1"` with `invalid input syntax for type uuid: "1"` |

Net effect: every browser mount (or any caller hitting the route with a
non-UUID id) produced one log line, and the UI rendered as if nothing
happened.

The stub ids in `INITIAL_THREADS` were then renamed from `"1"`, `"2"`,
`"3"`, `"4"` to `"local-1"`, `"local-2"`, `"local-3"`, `"local-4"`,
so the offline-stubs and the in-memory "New chat" entries share the
same `"local-"` prefix and a single `startsWith("local-")` check covers
both.

## The fix (verified)

### `app/assistant.tsx`

A small `isLocalThreadId(id)` helper checks the shared `"local-"`
prefix. The messages-loading effect guard uses it, and the same prefix
is checked directly in `components/assistant-ui/thread.tsx`'s note
editor. The offline stub entries in `INITIAL_THREADS` use the prefix
(`"local-1"`, `"local-2"`, ...), so a single check covers both them
and the in-memory "New chat" entries.

```ts
function isLocalThreadId(id: string | null | undefined): boolean {
  return !id || id.startsWith("local-");
}

// ...later, in the messages-loading effect:
if (!mounted || isLocalThreadId(activeThreadId)) {
  setThreadMessages([]);
  return;
}
```

### `app/api/threads/[id]/messages/route.ts`

Added the same `UUID_RE` check the sibling routes already use, so any
non-UUID id returns 404 before Postgres is touched:

```ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ...inside the GET handler:
if (!UUID_RE.test(id)) {
  return NextResponse.json(
    { error: "thread_not_found" },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}
```

## Sanitized probe (no secret exposure)

Run from the repo dir. None of these print env values or tokens.

```bash
# 1. Confirm the journal is clean for the running build
journalctl --user -u control-room.service --since "1 hour ago" --no-pager \
  | grep -E 'db\] call failed|invalid input syntax for type uuid' \
  && echo "STILL NOISY" || echo "clean ✓"

# 2. Hit a stub id directly -- must now 404 cleanly without a DB call
curl -s -o /dev/null -w "GET /api/threads/local-1/messages -> HTTP %{http_code}\n" \
  http://127.0.0.1:18100/api/threads/local-1/messages
curl -s http://127.0.0.1:18100/api/threads/local-1/messages
# expect: 404 {"error":"thread_not_found"}   (no DB call, no log line)

# 3. A bare-numeric id (the legacy shape, pre-rename) is also rejected cleanly
curl -s -o /dev/null -w "GET /api/threads/1/messages -> HTTP %{http_code}\n" \
  http://127.0.0.1:18100/api/threads/1/messages
# expect: 404 {"error":"thread_not_found"}   (UUID_RE guard on the API)

# 4. Real UUID path still works
curl -s -o /dev/null -w "GET /api/threads/<uuid>/messages -> HTTP %{http_code}\n" \
  http://127.0.0.1:18100/api/threads/00000000-0000-0000-0000-000000000000/messages
# expect: 404 {"error":"thread_not_found"}   (genuine thread lookup, not the guard)

# 5. Confirm the list endpoint still returns real threads
curl -s http://127.0.0.1:18100/api/threads | python3 -m json.tool
# expect: { "threads": [ { "id": "<uuid>", ... } ], "configured": true }
```

## What this fix does and does not do

- **Stops the recurring log line.** Verified clean on 2026-06-18 after
  `npm run build && systemctl --user restart control-room.service` — zero
  occurrences in the journal since restart.
- **Preserves the offline stub UX.** `INITIAL_THREADS` is still rendered in
  the sidebar on first paint before the DB returns, per the design intent in
  `docs/POSTGRES_PLAN.md` ("we do not yet remove the in-memory fallback").
  The stub ids carry the `"local-"` prefix so they share the same
  offline-only code path as in-memory "New chat" entries.
- **Defense in depth.** A non-UUID id now returns 404 cleanly from the API,
  even if some other caller (stale UI, a manually crafted URL, a future
  bug) sends one. The note routes already had this guard.
- **No schema change, no DB migration, no secrets touched, no commit/push
  performed automatically** without explicit ask.

## Pitfalls observed

- **`tryDb` makes DB errors invisible in the UI.** Anything routed through
  `lib/db.ts`'s `tryDb(fn, fallback)` is a silent fallback. A failing
  persisted-chat call does **not** surface as a UI error — only as a log
  line. Watch the journal, not the page.
- **Stub ids must use the `"local-"` prefix.** Any new offline stub
  thread added to `INITIAL_THREADS` (or anywhere else) must use the
  `"local-"` prefix so `isLocalThreadId()` and the matching guards in
  `components/assistant-ui/thread.tsx` correctly skip the persisted-chat
  API for them. A bare-integer id (or any other non-UUID, non-prefixed
  string) will currently fail the `"local-"` check and slip through to
  the API — where it is now caught by the `UUID_RE` guard on the GET
  handler, but the cleaner invariant is to keep the prefix.
- **Build vs. service timing.** `next start` reads the build output at
  startup. If you edit the route handler but only run `tsc --noEmit`
  without `npm run build`, the running service still has the old handler.
  Always rebuild before restarting for code changes.

## What to capture if it ever comes back

1. `journalctl --user -u control-room.service -n 100 --no-pager | grep -E 'db\]|uuid'`
2. The full request URL from any access log entry that correlates.
3. The active thread id shown in the UI sidebar (mock vs. UUID).
4. `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18100/api/threads/<id>/messages`
   for the offending id.
5. `git log --oneline -5` so the commit hash of the fix is known.

That's enough to tell whether the caller has regressed, the API guard has
regressed, or something new is sending non-UUID ids.