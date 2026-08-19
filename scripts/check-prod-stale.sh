#!/usr/bin/env bash
# Detect the "Live .next mutation hazard": on-disk .next was rebuilt but
# the running next start was NOT restarted, so the server is still
# serving HTML that references chunks from the OLD build.
#
# This is the exact failure mode that broke the live site on 2026-07-02:
# the running server's in-memory page cache held chunk names like
# 1z2juf2f2ud87.js / 2q0mlc27l6nz9.js that no longer existed on disk
# after a rebuild, so the browser fetched them and got 500 — and the
# page rendered as a blank <div class="h-dvh"></div>.
#
# Run this AFTER `npm run build` and BEFORE claiming the live site is
# fine. Exit codes:
#   0  production matches the build (or no build is in flight)
#   1  production is stale — restart required
#   2  unable to determine (server down, build artifacts missing, etc.)
#
# Usage:
#   scripts/check-prod-stale.sh              # check production on :18100
#   BASE_URL=http://127.0.0.1:18100 \
#     scripts/check-prod-stale.sh            # override base url

set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/hermes/workspace/repos/control-room}"
BASE_URL="${BASE_URL:-http://127.0.0.1:18100}"
BUILD_ID_FILE="${REPO_DIR}/.next/BUILD_ID"

note() { echo "[check-prod-stale] $*"; }
fail() { echo "[check-prod-stale] FAIL: $*" >&2; exit "${1:-1}"; }

if [[ ! -f "$BUILD_ID_FILE" ]]; then
  note "no .next/BUILD_ID found at $BUILD_ID_FILE — nothing to check"
  exit 2
fi

DISK_BUILD_ID="$(cat "$BUILD_ID_FILE")"
note "on-disk .next/BUILD_ID: $DISK_BUILD_ID"

# Probe the running server. The HTML response carries an escaped
# `\"b\":\"<BUILD_ID>\"` field inside the React Server Components
# inline script payload. We accept both the raw and escaped forms
# for forward compatibility. If the server is down we exit 2 so
# callers don't falsely report "all green".
SERVED_BUILD_ID="$(
  curl -fsS --max-time 5 "$BASE_URL/" \
    | tr ',' '\n' \
    | grep -oE '\\?"b\\?":\\?"[A-Za-z0-9_-]+' \
    | head -1 \
    | sed -E 's/^\\?"b\\?":\\?"([A-Za-z0-9_-]+).*$/\1/' || true
)"

if [[ -z "$SERVED_BUILD_ID" ]]; then
  # Fallback: same pattern, but allow the regex to be a bit looser.
  SERVED_BUILD_ID="$(
    curl -fsS --max-time 5 "$BASE_URL/" \
      | grep -oE 'b[\]\\]*:[\]\\]*"[A-Za-z0-9_-]+' \
      | head -1 \
      | sed -E 's/^b[\]\\]*:[\]\\]*"([A-Za-z0-9_-]+).*$/\1/' || true
  )"
fi

if [[ -z "$SERVED_BUILD_ID" ]]; then
  note "could not extract BUILD_ID from $BASE_URL/ — server may be down"
  exit 2
fi

note "served build id:        $SERVED_BUILD_ID"

if [[ "$DISK_BUILD_ID" == "$SERVED_BUILD_ID" ]]; then
  note "PASS: production matches the on-disk build"
  exit 0
fi

note "STALE: production was not restarted after the last build"
note "  on-disk: $DISK_BUILD_ID"
note "  served:  $SERVED_BUILD_ID"
note "  fix:     scripts/restart-prod.sh"
exit 1
