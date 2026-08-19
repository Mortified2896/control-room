# Control Room — Hermes VM dev workflow

> How to develop Control Room on the Hermes VM from a Mac.
> Status: Postgres persistence + Router A/B Mode MVP shipped (see `docs/database.md` + `docs/router-ab-mode.md`).
> Last verified: 2026-06-24, with the Router A/B Mode MVP merged.

If the page goes blank on load/refresh, jump straight to **§11** before
debugging the code.

---

## 1. Where the repo lives on the Hermes VM

- Path: `/home/hermes/workspace/repos/control-room`
- Remote: `https://github.com/Mortified2896/control-room.git`
- Branch: `main`
- Owner: `hermes:hermes`

If the directory is missing, clone with:

```bash
git clone https://github.com/Mortified2896/control-room.git
```

If present and clean, refresh with:

```bash
cd /home/hermes/workspace/repos/control-room
git status                     # must be clean
git pull --ff-only origin main
```

`dependencies` are already installed (`node_modules/` present). Re-install with `npm ci` if needed.

---

## 2. Postgres on the Hermes VM

The app talks to a local Postgres 15 instance on the same VM (host `127.0.0.1:5432`).

| Thing             | Value                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------- |
| Database          | `control_room`                                                                           |
| Role              | `control_room_app`                                                                       |
| Env file (host)   | `/etc/hermes/control_room_postgres.env`                                                  |
| Env var           | `CONTROL_ROOM_DATABASE_URL`                                                              |
| File mode / owner | `0640 root:hermes` — readable by the `hermes` user via group membership                  |
| Migrations        | `npm run db:migrate` (runs `scripts/migrate.mjs`, applies `db/migrations/0001_init.sql`) |
| Tables            | `threads`, `messages`, `message_feedback`                                                |

> The env file contains the database URL and password. Treat it as a secret.
> Do **not** print, copy, or commit its contents. Do **not** edit it from a non-root context.

Migrations are run from the repo root with the env file sourced:

```bash
cd /home/hermes/workspace/repos/control-room
set -a && . /etc/hermes/control_room_postgres.env && set +a
npm run db:migrate
```

The migration script is idempotent — re-running it is safe.

---

## 3. Why `bash -lc` is required

Non-interactive SSH (e.g. `ssh user@host 'cmd'`) starts a **non-login, non-interactive** shell. On the Hermes VM that means the user's normal PATH (which includes the Node.js install that ships `npm` and `npx`) is **not** loaded. Symptom:

```
nohup: failed to run command 'npm': No such file or directory
```

`bash -lc` forces a **login** shell, which sources `/etc/profile` and `~/.bash_profile` / `~/.bash_login` / `~/.profile`, restoring the PATH where `npm` lives. Use `bash -lc "..."` whenever a remote command needs `npm`, `npx`, `node`, or any other user-installed binary.

---

## 4. Start the dev server from a Mac

Single one-liner that sources the Postgres env, launches `next dev` bound to the VM's loopback in the background, and confirms the port answers:

```bash
ssh -J proxmox-home hermes@10.10.10.80 'bash -lc "cd /home/hermes/workspace/repos/control-room && set -a && . /etc/hermes/control_room_postgres.env && set +a && nohup npm run dev -- --hostname 127.0.0.1 --port 3000 > /tmp/control-room-dev.log 2>&1 & sleep 10 && curl -fsS -I http://127.0.0.1:3000 | head -n 1"'
```

What it does, in order:

1. `bash -lc "..."` — login shell so `npm` is on PATH (see §3).
2. `cd` into the repo.
3. `set -a; . /etc/hermes/control_room_postgres.env; set +a` — auto-export every variable from the env file, then stop auto-exporting.
4. `nohup npm run dev -- --hostname 127.0.0.1 --port 3000 > /tmp/control-room-dev.log 2>&1 &` — start Next.js dev in the background, redirect both streams to a log file. `--` passes `--hostname` and `--port` through to `next dev`.
5. `sleep 10` — give Next a moment to compile.
6. `curl -fsS -I http://127.0.0.1:3000 | head -n 1` — print the first response line (should be `HTTP/1.1 200 OK` once it's up).

Server runs on the VM, bound to `127.0.0.1:3000`. It is **not** reachable from the Mac without a tunnel (see §6).

---

## 5. Check the dev log

```bash
ssh -J proxmox-home hermes@10.10.10.80 'tail -n 200 /tmp/control-room-dev.log'
```

For live tailing:

```bash
ssh -J proxmox-home hermes@10.10.10.80 'tail -f /tmp/control-room-dev.log'
```

To stop the dev server:

```bash
ssh -J proxmox-home hermes@10.10.10.80 'pkill -f "next dev"'
```

---

## 6. SSH tunnel from the Mac

Forward the Mac's local port `3003` to the VM's loopback `3000`:

```bash
ssh -N -L 3003:127.0.0.1:3000 -J proxmox-home hermes@10.10.10.80
```

- `-N` — don't open a remote shell, just keep the tunnel up.
- `-L 3003:127.0.0.1:3000` — local `127.0.0.1:3003` → remote `127.0.0.1:3000`.
- `-J proxmox-home` — jump host (the Proxmox host the VM lives behind).

Run in a dedicated terminal tab. `Ctrl-C` to tear down.

---

## 7. Browser URL

On the Mac, after the tunnel is up and the dev server has answered `200`:

```
http://127.0.0.1:3003
```

---

## 8. "Port 3002 is taken on my Mac"

When iterating, you may find that a local process on the Mac is already bound to `3002` (or any other candidate port). Two options:

- **Pick a free port on the Mac** for the tunnel, e.g. `3003`. Use the same `3000` on the VM side — only the **local** half of the tunnel changes:

  ```bash
  ssh -N -L 3003:127.0.0.1:3000 -J proxmox-home hermes@10.10.10.80
  ```

  Then open `http://127.0.0.1:3003`.

- **Free the conflicting port** on the Mac (e.g. find the process with `lsof -nP -iTCP:3002 -sTCP:LISTEN` and stop it) and use `3002` for the tunnel.

There is no reason to change the VM-side port just because the Mac is busy — change the local half of the tunnel.

---

## 9. What "dev works" does NOT include yet

The backend has:

- `db/migrations/0001_init.sql` — `threads`, `messages`, `message_feedback` schema.
- `scripts/migrate.mjs` — migration runner, idempotent.
- `npm run db:migrate` — script alias.
- Write APIs that create threads and messages.

The UI still:

- Holds threads and the active thread id in client `useState` (`app/assistant.tsx`).
- Uses a hardcoded list of 4 starter threads.
- Generates `local-<timestamp>-<n>` ids for new chats.
- Holds message feedback votes in component-local `useState` with no backend call.

In other words: **the database is real and the write APIs exist, but the UI does not call them yet.** Do not assume data you see in the UI is in Postgres, and do not assume data in Postgres is visible in the UI.

---

## 10. Validation cheatsheet

Run from `/home/hermes/workspace/repos/control-room`:

```bash
npm run lint          # oxlint + oxfmt --check
npx tsc --noEmit      # typecheck (no `typecheck` script in package.json)
npm run build         # next build
```

`npm run db:migrate` is the only command that needs the env file sourced — lint, typecheck, and build do not.

---

## 11. White blank page after reload — how to recover

If the chat surface renders to a fully white blank page after a reload
(or a refresh, or after switching dev ↔ prod without a clean rebuild),
**the cause is almost always stale build artefacts or orphaned Next.js
processes, not a code bug.** Two fixes, in order:

### 11.1 Nuclear option (use first — fixes the issue 99% of the time)

```bash
ssh -J proxmox-home hermes@10.10.10.80 'bash -lc "
  cd /home/hermes/workspace/repos/control-room
  set -a && . /etc/hermes/control_room_postgres.env && set +a
  pkill -9 -f \"next dev\"      2>/dev/null || true
  pkill -9 -f \"next-server\"  2>/dev/null || true
  pkill -9 -f \"next start\"  2>/dev/null || true
  rm -rf .next
  echo \"--- killed leftovers + wiped .next ---\"
"'
```

Then start the server the way you normally do (dev or prod). What each
line does:

- The three `pkill`s terminate any leftover Next.js processes. On the
  Hermes VM (and on most dev machines), `npm run dev` and `npm run
start` use different binary names — `pkill -f "next dev"` alone
  misses `next start` / `next-server`. Without the kill, two servers
  can race for the same port and one of them serves stale chunks
  built against an older `.next/` directory, which hydrates to a
  blank `<div className="h-dvh" />` and stops there.
- `rm -rf .next` wipes the build cache. Next.js 16 with Turbopack can
  hydrate inconsistently if the server bundle (one `.next/`) and the
  client chunks (different path inside the same `.next/`) end up
  out of sync, which happens easily when you've been toggling between
  `npm run dev` and `npm run start`. A clean build eliminates the
  race entirely.

### 11.2 Confirm it's not actually a code bug

If the page is still blank after the nuclear option, it's a real code
bug. Validate with the Playwright suite (the spec walks the exact
load-and-reload path and captures screenshots):

```bash
ssh -J proxmox-home hermes@10.10.10.80 'bash -lc "
  cd /home/hermes/workspace/repos/control-room
  set -a && . /etc/hermes/control_room_postgres.env && set +a
  CONTROL_ROOM_FAKE_LLM=1 npm run test:e2e
"'
```

If a spec fails, the failure context under `test-results/` includes:

- a Playwright trace ZIP (`test-results/<spec-name>-<test-name>-chromium/trace.zip`) — open with `npx playwright show-trace <path>` for step-by-step event timeline + screenshot at each step.
- a `error-context.md` with the accessibility-snapshot YAML of the page at the moment of failure. Look for `<div class=\"h-dvh\">` in the YAML — that confirms hydration didn't complete.

The single-page `app/assistant.tsx` intentionally renders
`<div className="h-dvh" />` until the React `useEffect` flips
`mounted = true` on the client. If that `useEffect` never runs (JS
error, blocked cross-origin dev resources, etc.), the page stays
white. Run:

```bash
ssh -J proxmox-home hermes@10.10.10.80 'tail -n 60 /tmp/control-room-dev.log'
```

and look for the Next.js cross-origin block warning:

```
Blocked cross-origin request to Next.js dev resource /_next/webpack-hmr
from \"<host>\".

To allow this host in development, add it to \"allowedDevOrigins\"
in next.config.js and restart the dev server
```

If you see that, the offending host is missing from
`allowedDevOrigins` in `next.config.ts`. Add it (the
`127.0.0.1` and `localhost` entries are already there for local
dev) and restart.

### 11.3 When in doubt, run prod

The dev server (Turbopack) is more prone to hydration surprises than
the prod build. If a "blank page" report is hard to reproduce, build
prod and run from there:

```bash
ssh -J proxmox-home hermes@10.10.10.80 'bash -lc "
  cd /home/hermes/workspace/repos/control-room
  set -a && . /etc/hermes/control_room_postgres.env && set +a
  pkill -9 -f \"next\"          2>/dev/null || true
  rm -rf .next
  npm run build
  CONTROL_ROOM_FAKE_LLM=1 nohup npm run start -- --port 3000 --hostname 127.0.0.1 \\
    > /tmp/control-room-prod.log 2>&1 &
  sleep 5
  curl -fsS -I http://127.0.0.1:3000 | head -n 1
"'
```

If prod renders fine but dev does not, the issue is a stale Turbopack
state and the §11.1 nuclear option is the right fix. If prod also
renders blank, look for a real bug — start from the Playwright
trace ZIP.

---

## 12. Quickstart (cheat sheet)

```bash
# 1. Start the dev server (in a Mac terminal, single shot)
ssh -J proxmox-home hermes@10.10.10.80 \
  'bash -lc "cd /home/hermes/workspace/repos/control-room && \
             set -a && . /etc/hermes/control_room_postgres.env && set +a && \
             nohup npm run dev -- --hostname 127.0.0.1 --port 3000 \
             > /tmp/control-room-dev.log 2>&1 & \
             sleep 10 && curl -fsS -I http://127.0.0.1:3000 | head -n 1"'

# 2. Open the tunnel (in a separate Mac terminal, leave running)
ssh -N -L 3003:127.0.0.1:3000 -J proxmox-home hermes@10.10.10.80

# 3. Open the app
open http://127.0.0.1:3003

# 4. Tail logs when something looks off
ssh -J proxmox-home hermes@10.10.10.80 'tail -f /tmp/control-room-dev.log'
```
