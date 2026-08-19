# OpenAI API key troubleshooting — Control Room

When chat completions in Control Room (`/api/chat`) start failing, walk this checklist
before debugging the app. It is calibrated to the **exact** way this app loads and
uses the OpenAI key on this VM, and to the failure modes that have actually been seen
here.

## TL;DR

| Symptom in `/api/chat` SSE stream                                                                 | Most likely cause                                                                                               |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `data: {"type":"error","errorText":"An error occurred."}`                                         | OpenAI rejected the request. Cause is in the upstream error, **not** visible in the SSE stream. Probe directly. |
| `{"error":"unknown_model","modelId":"...","allowedIds":[...]}`                                    | The `modelId` sent by the client is not in the hard-coded allowlist in `lib/providers/openai.ts`.               |
| `{"error":"provider_disabled","providerId":"openai","reason":"OPENAI_API_KEY is not configured"}` | `process.env.OPENAI_API_KEY` is empty/missing in the running Next.js process.                                   |
| `{"error":"no_models_available",...}`                                                             | No provider has a key set. See above.                                                                           |

The SSE error stream is **deliberately generic** — the AI SDK stringifies upstream
errors. You cannot tell from the SSE body alone whether the cause is auth, quota,
rate-limit, model-not-found, or org/project. Probe directly.

## How the app loads the OpenAI key (verified on this VM)

1. The app code reads `process.env.OPENAI_API_KEY` (see `lib/providers/openai.ts`).
2. `@ai-sdk/openai` (v3.0.x) reads the same variable name. It is hard-coded in the
   SDK as `environmentVariableName: "OPENAI_API_KEY"`. There is no override in
   `app/api/chat/route.ts`.
3. The key is **not** injected by the systemd unit. The `control-room.service`
   unit file (user unit at `~/.config/systemd/user/control-room.service`) only
   passes `NODE_ENV`, `PATH`, and the postgres env file. The unit comment
   explicitly states the app is meant to read the key from `.env.local`.
4. In production, `next start` loads `.env.local` into `process.env` at startup
   (Next.js bundled `loadEnvConfig` walks `.env.production.local`, `.env.local`,
   `.env.production`, `.env` in that order, populating only unset vars).
5. **`.env.local` is read exactly once at process start.** Editing the file after
   `next-server` is running has no effect on that process. Restart the service
   for changes to take effect.

### What the raw process env does and does not show

- `tr '\0' '\n' < /proc/<next-server-pid>/environ` will show
  `OPENAI_API_KEY: missing` even when the key is working, because the dotenv
  merge updates Node's `process.env` after fork and is not reflected back into
  the kernel's environ blob. Do not conclude "key is missing" from a
  `/proc/PID/environ` scan. Use `/api/models` instead: if OpenAI entries show
  `enabled: true`, the key reached the app.

## Sanitized 60-second probe (no secret exposure)

Run from the repo dir. None of these commands print key values.

```bash
# 1. .env.local exists with a non-empty OPENAI_API_KEY (names + lengths only)
python3 -c "
import re, pathlib
p = pathlib.Path('.env.local')
print('present:', p.exists(), '| mode:', oct(p.stat().st_mode & 0o777), '| size:', p.stat().st_size)
for line in p.read_text().splitlines():
    s = line.strip()
    if not s or s.startswith('#'): continue
    m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)=(.*)$', s)
    if m: print(f'  {m.group(1)}: {\"set (len=\"+str(len(m.group(2).strip().strip(chr(34)+chr(39))))+\")\" if m.group(2).strip() else \"empty\"}')
"

# 2. Confirm the running process picked up the key (presence in /api/models)
curl -s http://127.0.0.1:18100/api/models | python3 -m json.tool

# 3. Live chat test with one of the app's allowed model IDs
curl -sN -X POST http://127.0.0.1:18100/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"modelId":"gpt-5.4-mini","messages":[{"id":"m1","role":"user","parts":[{"type":"text","text":"reply with the single word: ok"}]}]}'
```

A successful response ends with `data: {"type":"finish","finishReason":"stop"}` →
`data: [DONE]`.

If `/api/chat` returns the generic `errorText: "An error occurred."`, probe
OpenAI directly. The script below reads the key from `.env.local` and never
prints the value, only the HTTP status, error type, error code, and a truncated
error message:

```bash
python3 - <<'PY'
import json, urllib.request, urllib.error
key = None
with open('.env.local') as f:
    for line in f:
        s = line.strip()
        p = 'OPENAI_API_KEY' + '='
        if s.startswith(p):
            key = s[len(p):].strip().strip('"').strip("'")
            break
assert key, 'OPENAI_API_KEY not found in .env.local'
auth = 'Authorization'
bearer = 'Bearer ' + key
for url, method, body in [
    ('https://api.openai.com/v1/models', 'GET', None),
]:
    req = urllib.request.Request(url, method=method, headers={auth: bearer})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            print(method, url, '->', r.status)
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8','replace')
        try: j = json.loads(raw)
        except Exception: j = {}
        err = j.get('error', {}) if isinstance(j, dict) else {}
        print(method, url, '->', e.code,
              '| type=', err.get('type'),
              '| code=', err.get('code'),
              '| msg=', (err.get('message') or '')[:200])
PY
```

### What each OpenAI error category means in practice

| OpenAI response                                         | Meaning in this app                                                                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `401 invalid_api_key`                                   | The key in `.env.local` is wrong/revoked/mistyped. **Most common cause.** Replace the key, restart the service.         |
| `401 incorrect_organization` / `invalid_organization`   | The key is valid but tied to a different org. Set `OPENAI_ORG_ID` / `OPENAI_ORGANIZATION` in `.env.local`.              |
| `403 insufficient_quota` / `billing_hard_limit_reached` | Account out of credit. Not a code/config issue.                                                                         |
| `404 model_not_found`                                   | Hard-coded `modelId` in `lib/providers/openai.ts` is no longer (or never was) a valid model.                            |
| `429 rate_limit_exceeded`                               | Back off and retry. Consider lowering request rate.                                                                     |
| `5xx`                                                   | OpenAI side. Check https://status.openai.com.                                                                           |
| 200 with the right number of model IDs in `data[].id`   | Auth is fine. The `modelId`s in `lib/providers/openai.ts` are real (confirmed for the current allowlist on 2026-06-18). |

## Restart procedure

The unit has `Restart=always`, so the simplest path is:

```bash
systemctl --user restart control-room.service
sleep 1
ss -ltnp | grep 18100   # confirm new PID
curl -s http://127.0.0.1:18100/api/models | python3 -m json.tool
```

`next start` reads `.env.local` once at boot. Edits made after the server is up
are silently ignored until the next restart.

## Pitfalls observed on this VM

- **`/proc/<pid>/environ` does not reflect `.env.local`.** It is normal for
  `OPENAI_API_KEY` to be "missing" in raw environ even when the chat works.
  Trust `/api/models` `enabled: true` instead.
- **Generic SSE error text masks the real cause.** Always probe OpenAI directly
  when `/api/chat` returns `errorText: "An error occurred."`.
- **`gpt-5.5` and `gpt-5.4-mini` are real OpenAI model IDs** (verified
  2026-06-18 by `GET /v1/models` against a working key returning both).
  Earlier debugging notes that flagged these as fictional were wrong.
- **The model allowlist in `lib/providers/openai.ts` is the only thing
  determining which `modelId` values the client may pass.** Even valid OpenAI
  models (e.g. `gpt-4o-mini`) will be rejected with `unknown_model` (400) if
  they are not in that allowlist. This is by design; expand the array to expose
  more models.
- **`.env.local` mode must be `0600`** because the file holds a secret. The
  systemd unit has no `User=` override, so the key file is read by the same
  `hermes` user that owns the repo.
- **Editing `.env.local` does not require a git commit.** It is git-ignored
  (`.gitignore` line 34: `.env*`, with `!.env.example`). Do not `git add -f`
  it.

## What to capture in a new ticket

When this happens again, capture **before** changing anything:

1. `ls -la .env.local` (mode, size, mtime)
2. The Python snippet above (key names + lengths, no values)
3. `ss -ltnp | grep 18100` (PID of the running `next-server`)
4. `ps -o pid,etime,cmd -p <PID>` (uptime — fresh restart vs. stale)
5. `/api/models` response (presence of `enabled: true` for OpenAI)
6. `/api/chat` SSE body (full stream, not just the first event)
7. The direct OpenAI probe result (status, error type, error code, message)

That is enough to localize the cause to: missing env var, wrong var name,
invalid key, quota, rate limit, model not found, wrong org/project, or an
OpenAI status incident — without exposing the key value.
