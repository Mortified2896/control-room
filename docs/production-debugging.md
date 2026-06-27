# Control Room Production Debugging & Restart Checklist

## When to use this checklist

Use this checklist after any change involving:

- API routes under `app/api/**`
- database schema or migrations
- server-side environment variables
- auth/provider/model config
- Next.js build output
- package/dependency changes
- route structure changes
- anything that works in build but fails in the live website

## Mental model

- `npm run build` only updates `.next`.
- Already-running `next start` processes do **not** automatically load the new build.
- If old `next-server` processes stay alive, new API routes may not exist in the live runtime.
- Missing API routes can fall through to app HTML.
- The frontend may then try to parse HTML as JSON and crash.
- Starting without Postgres env can make APIs behave as unconfigured even when the code is correct.

Recent `/api/projects` incident:

**Problem:**

- Old `next-server` processes from before the new build were still serving traffic.
- Those old processes did not know about `/api/projects`.
- Requests to `/api/projects` returned HTML instead of JSON.
- The frontend tried to parse HTML as JSON and the site broke.

**Root cause:**

- Build succeeded, but production runtime was stale.
- One restart attempt also missed `/etc/hermes/control_room_postgres.env`.

## Live `.next` mutation hazard

The production app serves its built routes, manifests, and client assets from
`.next`. Running `npm run build` rewrites `.next` in place.

If an old `next start` process continues serving while `.next` is replaced, the
live website may break even though production was not explicitly restarted. The
old runtime can serve mismatched assets, routes, and manifests from the newly
mutated build directory.

Therefore, build + restart + smoke check must be treated as one deploy operation
for API, UI, and server changes. Do not run `npm run build` in the live serving
directory and then leave the old `next start` process running.

If an agent is running inside a Control Room-hosted chat/session, it must not
restart the Control Room process that is hosting its own active response. In
that case, it should not run the production build in the live serving directory
unless an external restart is immediately planned.

If the agent is running externally — for example from Pi terminal, Pi Telegram,
OpenCode terminal, Codex terminal/app, SSH, tmux, or systemd — it may restart
Control Room. The browser tab may disconnect or need a refresh, but the external
worker/session should continue.

If the site breaks after a build, first run `scripts/restart-prod.sh` from an
external session, then run `scripts/smoke-prod.sh`.

Hard rule: For API/UI/server changes in the live repo, agents must not run
`npm run build` and then leave production running on the old process. Either:

1. build only in a non-serving copy/worktree, or
2. build and immediately restart production from a session that is not hosted by
   the Control Room process being restarted, followed by smoke checks and
   rendered UI verification if applicable.

## Golden rule

After schema/API/server changes:

1. run `npm run db:migrate` if needed
2. run `npm run typecheck`
3. run `npm test`
4. run `npm run build`
5. restart the deployed production process with the correct env using `scripts/restart-prod.sh`
6. smoke test JSON APIs with `scripts/smoke-prod.sh`
7. only then report success

A successful build is not enough.

## Safe restart command

Preferred helper, run from a session that is not hosted by the Control Room process being restarted (for example Pi terminal, Pi Telegram, OpenCode terminal, Codex terminal/app, SSH, tmux, or systemd):

```bash
cd /home/hermes/workspace/repos/control-room
scripts/restart-prod.sh
```

The script sources `/etc/hermes/control_room_postgres.env`, narrowly restarts the Control Room listener on port `18100`, and then runs `scripts/smoke-prod.sh`.

Underlying production start command:

```bash
cd /home/hermes/workspace/repos/control-room
set -a
. /etc/hermes/control_room_postgres.env
set +a
npm run start -- -p 18100 -H 127.0.0.1
```

Important:

- Do not start production without sourcing `/etc/hermes/control_room_postgres.env`.
- Do not assume `npm run build` restarted the live app.
- Do not restart Control Room from inside a Control Room-hosted WebUI/chat stream if that would kill the running response.
- External Pi/OpenCode/Codex/SSH/tmux/systemd sessions may restart Control Room; the browser tab may disconnect or need refresh, but the external worker should continue.
- If operating inside the active Control Room-hosted app session, stop and give the user an external Pi/OpenCode/Codex/SSH/systemctl/tmux command instead.

## Process checks

Inspect whether stale production processes exist:

```bash
ps -eo pid,ppid,lstart,cmd | grep -E 'next-server|next start|control-room' | grep -v grep
```

Guidance:

- Check process start time.
- If the process started before the latest build, it is probably stale.
- Ensure only the intended production process is serving port `18100`.

Port check:

```bash
ss -ltnp | grep ':18100'
```

## Stale browser/client bundle checklist

Use this checklist after any change involving:

- React components
- sidebar/header/layout UI
- buttons or menus
- client hooks/state
- CSS/Tailwind/classes
- anything under `components/**`
- anything that should visibly appear in the browser

Mental model:

- `npm run build` creates new client/server output.
- The running production process must be restarted to serve the new build.
- The browser may still hold an old JS bundle until refresh.
- A screenshot showing old UI after a claimed UI change is not a frontend mystery; first assume stale runtime or stale browser bundle.
- Do not debug React logic until build/restart/refresh/render verification has been completed.

Required sequence after UI changes:

```bash
cd /home/hermes/workspace/repos/control-room
npm run typecheck
npm test
npm run build
# From a session not hosted by the Control Room process being restarted:
scripts/restart-prod.sh
```

Then verify in browser:

- Hard refresh the page.
- If still stale, open with a cache-busting query param, for example:
  `https://hermes-agent.taile0361b.ts.net:9443/?v=<timestamp>`
- Check that the expected UI element is visibly rendered.

Example — “Delete all chats” button:

- Expected location: directly under “New Chat” and above “Search chats…”
- If it is missing, do not claim success.
- First verify that production was rebuilt and restarted.
- Then hard-refresh/cache-bust the browser.
- Then inspect the rendered DOM or use a browser screenshot.

Rule: A successful UI change requires rendered UI verification, not only build/typecheck/test success.

## Smoke checks after restart

The safe repeatable smoke check is:

```bash
scripts/smoke-prod.sh
```

It does not restart anything. It checks the homepage and verifies key API routes return JSON instead of an HTML page shell.

Equivalent exact JSON smoke checks:

```bash
curl -fsS http://127.0.0.1:18100/api/projects | jq .
curl -fsS 'http://127.0.0.1:18100/api/threads?projectId=null' | jq .
```

General HTML check:

```bash
curl -fsSI http://127.0.0.1:18100/
```

JSON/content-type warning:

- API routes should return JSON, not HTML.
- If an API endpoint returns `<!DOCTYPE html>` or a page shell, the route is missing/stale/misrouted.
- Fix runtime/restart before debugging frontend JSON parsing.

## Database/env checks

Load the production DB env before DB-backed commands or production starts:

```bash
set -a
. /etc/hermes/control_room_postgres.env
set +a
```

Then:

- Check DB-backed APIs after env load.
- `configured:false` usually means the app process does not have the expected DB env.
- Do not “fix” app code until the runtime env has been verified.

## Recommended deploy sequence

```bash
cd /home/hermes/workspace/repos/control-room
# if the change includes migrations:
npm run db:migrate
npm run typecheck
npm test
npm run build
set -a
. /etc/hermes/control_room_postgres.env
set +a
# from Pi/OpenCode/Codex/SSH/tmux/systemd, not a Control Room-hosted chat stream:
scripts/restart-prod.sh
scripts/smoke-prod.sh
```

Manual equivalent smoke checks:

```bash
curl -fsS http://127.0.0.1:18100/api/projects | jq .
curl -fsS 'http://127.0.0.1:18100/api/threads?projectId=null' | jq .
curl -fsSI http://127.0.0.1:18100/
```

If a migration is part of the change, run it before build/restart using the same env-loaded shell.

## Future improvement

The repo now includes:

- `scripts/smoke-prod.sh` — safe to run after changes; it does not restart anything.
- `scripts/restart-prod.sh` — restarts the current production process on port `18100`, then runs smoke checks. Run it from a session that is not hosted by the Control Room process being restarted (Pi/OpenCode/Codex/SSH/tmux/systemd is OK), not from inside a Control Room-hosted active chat stream.

Later improvements should include a proper process manager/systemd unit if not already used.

For now, follow this checklist and use these scripts before reporting the live website as fixed.
