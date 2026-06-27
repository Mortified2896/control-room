#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${CONTROL_ROOM_PROD_URL:-http://127.0.0.1:18100}"

echo "[smoke-prod] Checking Control Room production at ${BASE_URL}"

fail() {
  echo "[smoke-prod] FAIL: $*" >&2
  exit 1
}

pass() {
  echo "[smoke-prod] PASS: $*"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

require_cmd curl
require_cmd jq

check_not_html() {
  local file="$1"
  local label="$2"

  if head -c 256 "$file" | grep -Eiq '^[[:space:]]*<!DOCTYPE html|^[[:space:]]*<html'; then
    echo "[smoke-prod] Response body for ${label}:" >&2
    head -c 500 "$file" >&2 || true
    echo >&2
    fail "${label} returned HTML instead of JSON; production runtime may be stale or route may be misconfigured"
  fi

  if grep -Eiq '<script[^>]+/_next/|<div id="__next"|Next\.js|self\.__next_f' "$file"; then
    echo "[smoke-prod] Response body for ${label}:" >&2
    head -c 500 "$file" >&2 || true
    echo >&2
    fail "${label} returned a Next.js page shell instead of JSON"
  fi
}

check_json_api() {
  local path="$1"
  local label="$2"
  local tmp
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' RETURN

  echo "[smoke-prod] GET ${path}"
  curl -fsS "${BASE_URL}${path}" -o "$tmp" || fail "curl failed for ${label}"
  check_not_html "$tmp" "$label"
  jq . "$tmp" || fail "${label} did not return valid JSON"
  pass "${label} returned valid JSON"
}

echo "[smoke-prod] HEAD /"
curl -fsSI "${BASE_URL}/" >/dev/null || fail "homepage header check failed"
pass "homepage responds"

check_json_api "/api/projects" "/api/projects"
check_json_api "/api/threads?projectId=null" "/api/threads?projectId=null"

pass "production smoke checks completed"
