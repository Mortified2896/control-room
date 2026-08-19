#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/home/hermes/workspace/repos/control-room"
ENV_FILE="/etc/hermes/control_room_postgres.env"
HOST="127.0.0.1"
PORT="18100"
LOG_FILE="/tmp/control-room-${PORT}.log"

fail() {
  echo "[restart-prod] FAIL: $*" >&2
  exit 1
}

status() {
  echo "[restart-prod] $*"
}

status "This script restarts the Control Room production process on ${HOST}:${PORT}."
status "Run it from an external SSH/tmux/system session, not from inside an active Control Room chat stream."

cd "$REPO_DIR"

[[ -f "$ENV_FILE" ]] || fail "missing env file: ${ENV_FILE}"

set -a
# shellcheck source=/etc/hermes/control_room_postgres.env
. "$ENV_FILE"
set +a

[[ -n "${CONTROL_ROOM_DATABASE_URL:-}" ]] || fail "CONTROL_ROOM_DATABASE_URL is not set after sourcing ${ENV_FILE}"

listener_pids() {
  ss -ltnp "sport = :${PORT}" 2>/dev/null \
    | grep -oE 'pid=[0-9]+' \
    | cut -d= -f2 \
    | sort -u || true
}

verify_control_room_pid() {
  local pid="$1"
  [[ -d "/proc/${pid}" ]] || return 1

  local cmd cwd
  cmd="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)"
  cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"

  if [[ "$cwd" != "$REPO_DIR" ]]; then
    echo "[restart-prod] Refusing to kill pid ${pid}: cwd is '${cwd}', expected '${REPO_DIR}'" >&2
    return 1
  fi

  if [[ "$cmd" != *"next-server"* && "$cmd" != *"next start"* && "$cmd" != *"next"* ]]; then
    echo "[restart-prod] Refusing to kill pid ${pid}: command does not look like Next.js: ${cmd}" >&2
    return 1
  fi

  return 0
}

pids="$(listener_pids)"
if [[ -n "$pids" ]]; then
  status "Found existing listener(s) on ${PORT}: ${pids}"
  for pid in $pids; do
    verify_control_room_pid "$pid" || fail "port ${PORT} is owned by an unexpected process; inspect with: ss -ltnp | grep ':${PORT}'"
  done

  for pid in $pids; do
    status "Stopping pid ${pid}"
    kill "$pid"
  done

  for _ in {1..30}; do
    if [[ -z "$(listener_pids)" ]]; then
      break
    fi
    sleep 1
  done

  if [[ -n "$(listener_pids)" ]]; then
    fail "port ${PORT} is still in use after graceful stop"
  fi
else
  status "No existing listener on ${PORT}"
fi

status "Starting production: npm run start -- -p ${PORT} -H ${HOST}"
nohup npm run start -- -p "$PORT" -H "$HOST" > "$LOG_FILE" 2>&1 &
new_pid="$!"
status "Spawned start wrapper pid ${new_pid}; log: ${LOG_FILE}"

for _ in {1..30}; do
  if curl -fsSI "http://${HOST}:${PORT}/" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

curl -fsSI "http://${HOST}:${PORT}/" >/dev/null 2>&1 || {
  tail -80 "$LOG_FILE" >&2 || true
  fail "production did not become ready on ${HOST}:${PORT}"
}

status "Running smoke checks"
"${REPO_DIR}/scripts/smoke-prod.sh"

status "Restart and smoke checks completed successfully"
