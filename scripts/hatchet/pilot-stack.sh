#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="control-room-hatchet-pilot"
EXPECTED_RUNTIME_UID="1000"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
COMPOSE_FILE="${REPOSITORY_ROOT}/infra/hatchet/compose.yaml"
ENV_FILE="${HATCHET_PILOT_ENV_FILE:-${HOME}/.config/control-room/hatchet-pilot.env}"

fail() {
  echo "$1" >&2
  exit 1
}

read_env_value() {
  local key="$1"
  awk -v key="${key}" '
    index($0, key "=") == 1 { value = substr($0, length(key) + 2) }
    END { print value }
  ' "${ENV_FILE}"
}

validate_env_file() {
  [[ "${ENV_FILE}" == /* ]] || fail "Secret env file path must be absolute"
  [[ -f "${ENV_FILE}" && ! -L "${ENV_FILE}" ]] ||
    fail "Expected a regular, non-symlink secret env file at ${ENV_FILE}"

  local env_mode
  env_mode="$(stat -c '%a' "${ENV_FILE}" 2>/dev/null || stat -f '%Lp' "${ENV_FILE}")"
  [[ "${env_mode}" == "600" ]] ||
    fail "Secret env file must have mode 600 (found ${env_mode})"

  local pg_user pg_database pg_password cookie_secrets tenant_id
  pg_user="$(read_env_value HATCHET_PILOT_PG_USER)"
  pg_database="$(read_env_value HATCHET_PILOT_PG_DATABASE)"
  pg_password="$(read_env_value HATCHET_PILOT_PG_PASSWORD)"
  cookie_secrets="$(read_env_value HATCHET_PILOT_COOKIE_SECRETS)"
  tenant_id="$(read_env_value HATCHET_PILOT_TENANT_ID)"

  [[ "${pg_user}" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] ||
    fail "HATCHET_PILOT_PG_USER must be a simple PostgreSQL identifier"
  [[ "${pg_database}" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] ||
    fail "HATCHET_PILOT_PG_DATABASE must be a simple PostgreSQL identifier"
  [[ "${pg_password}" =~ ^[0-9a-fA-F]{32,128}$ ]] ||
    fail "HATCHET_PILOT_PG_PASSWORD must be 32 to 128 hexadecimal characters"
  [[ "${cookie_secrets}" =~ ^[0-9a-fA-F]{32}[[:space:]][0-9a-fA-F]{32}$ ]] ||
    fail "HATCHET_PILOT_COOKIE_SECRETS must be two 32-character hexadecimal values"
  [[ "${tenant_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] ||
    fail "HATCHET_PILOT_TENANT_ID must be a lowercase UUID"
}

state_root() {
  local root
  root="$(read_env_value HATCHET_PILOT_STATE_DIR_HOST)"
  [[ "${root}" == /* ]] || fail "HATCHET_PILOT_STATE_DIR_HOST must be absolute"
  [[ "${root}" != "/" && "${root}" != "${HOME}" && "${root}" != "${REPOSITORY_ROOT}" ]] ||
    fail "HATCHET_PILOT_STATE_DIR_HOST is too broad"
  [[ "$(basename -- "${root}")" == "${PROJECT_NAME}" ]] ||
    fail "HATCHET_PILOT_STATE_DIR_HOST must end with ${PROJECT_NAME}"
  printf '%s\n' "${root}"
}

prepare_state() {
  local root parent
  root="$(state_root)"
  parent="$(dirname -- "${root}")"

  [[ "$(id -u)" == "${EXPECTED_RUNTIME_UID}" ]] ||
    fail "Run prepare-state as the dedicated UID ${EXPECTED_RUNTIME_UID} service user"
  [[ -d "${parent}" && ! -L "${parent}" ]] ||
    fail "State parent must already be a real directory"
  [[ "$(realpath -e "${parent}")" == "${parent}" ]] ||
    fail "State parent must not traverse symlinks"

  install -d -m 700 "${root}" "${root}/runtime" "${root}/otel"
  require_state_layout
}

require_state_layout() {
  local root path mode owner
  root="$(state_root)"
  for path in "${root}" "${root}/runtime" "${root}/otel"; do
    [[ -d "${path}" && ! -L "${path}" ]] ||
      fail "Expected a real pilot state directory at ${path}; run prepare-state"
    [[ "$(realpath -e "${path}")" == "${path}" ]] ||
      fail "Pilot state path must not traverse symlinks: ${path}"
    mode="$(stat -c '%a' "${path}")"
    owner="$(stat -c '%u' "${path}")"
    [[ "${mode}" == "700" && "${owner}" == "${EXPECTED_RUNTIME_UID}" ]] ||
      fail "Pilot state path must be mode 700 and owned by UID ${EXPECTED_RUNTIME_UID}: ${path}"
  done
}

validate_env_file
tenant_id="$(read_env_value HATCHET_PILOT_TENANT_ID)"

compose=(
  docker compose
  --project-name "${PROJECT_NAME}"
  --env-file "${ENV_FILE}"
  --file "${COMPOSE_FILE}"
)

case "${1:-}" in
  prepare-state)
    prepare_state
    ;;
  validate)
    require_state_layout
    "${compose[@]}" config --quiet
    ;;
  pull)
    require_state_layout
    "${compose[@]}" pull postgres hatchet otel-collector
    ;;
  build)
    require_state_layout
    "${compose[@]}" build worker runner
    ;;
  up-control-plane)
    require_state_layout
    "${compose[@]}" up --detach postgres otel-collector hatchet
    ;;
  bootstrap-token)
    require_state_layout
    raw_token="$("${compose[@]}" exec -T hatchet \
      /hatchet-admin --config /config token create \
      --name control-room-hatchet-pilot-worker \
      --tenant-id "${tenant_id}" \
      --expiresIn 24h)"
    token="$(printf '%s\n' "${raw_token}" | grep -Eo 'eyJ[A-Za-z0-9._-]+' | tail -n 1)"
    [[ "${token}" =~ ^eyJ[A-Za-z0-9._-]+$ ]] ||
      fail "Hatchet admin did not return a valid JWT"
    env_tmp="${ENV_FILE}.tmp.$$"
    umask 077
    grep -v '^HATCHET_PILOT_WORKER_TOKEN=' "${ENV_FILE}" >"${env_tmp}"
    printf 'HATCHET_PILOT_WORKER_TOKEN=%s\n' "${token}" >>"${env_tmp}"
    chmod 600 "${env_tmp}"
    mv "${env_tmp}" "${ENV_FILE}"
    echo "Wrote a 24-hour tenant-scoped worker token to the mode-600 env file."
    ;;
  up)
    require_state_layout
    worker_token="$(read_env_value HATCHET_PILOT_WORKER_TOKEN)"
    [[ "${worker_token}" =~ ^eyJ[A-Za-z0-9._-]+$ ]] ||
      fail "Bootstrap a valid worker token before starting the worker"
    "${compose[@]}" up --detach postgres otel-collector hatchet worker
    ;;
  run-standard)
    require_state_layout
    cleanup_secondary() {
      "${compose[@]}" --profile parallel stop worker-secondary >/dev/null
    }
    trap cleanup_secondary EXIT
    "${compose[@]}" --profile parallel up --detach --wait --wait-timeout 60 worker-secondary
    "${compose[@]}" --profile tools run --rm runner standard
    cleanup_secondary
    trap - EXIT
    ;;
  status)
    require_state_layout
    "${compose[@]}" ps
    ;;
  down)
    require_state_layout
    "${compose[@]}" down --remove-orphans
    ;;
  purge)
    require_state_layout
    [[ "${HATCHET_PILOT_CONFIRM_PURGE:-}" == "${PROJECT_NAME}" ]] ||
      fail "Set HATCHET_PILOT_CONFIRM_PURGE=${PROJECT_NAME} to remove only this pilot's volumes"
    docker ps --all \
      --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
      --format 'container {{.Names}} {{.Status}}'
    docker network ls \
      --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
      --format 'network {{.Name}}'
    docker volume ls \
      --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
      --format 'volume {{.Name}}'
    "${compose[@]}" down --volumes --remove-orphans
    ;;
  *)
    echo "Usage: $0 {prepare-state|validate|pull|build|up-control-plane|bootstrap-token|up|run-standard|status|down|purge}" >&2
    exit 2
    ;;
esac
