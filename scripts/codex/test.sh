#!/bin/sh
set -eu

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

CONFIG="$TMP/config with spaces.toml"
printf 'model = "example"\n' > "$CONFIG"

OUTPUT=$(python3 "$HERE/configure-autonomous-dev.py" --path "$CONFIG")
grep -q '^approval_policy = "never"$' "$CONFIG"
grep -q '^default_permissions = "autonomous-dev"$' "$CONFIG"
grep -q '^model = "example"$' "$CONFIG"
grep -q '^\[permissions.autonomous-dev\]$' "$CONFIG"
BACKUP=$(printf '%s\n' "$OUTPUT" | sed -n 's/^backup: //p')
test -f "$BACKUP"
test "$(cat "$BACKUP")" = 'model = "example"'
printf '%s\n' "$OUTPUT" | grep -Fq "rollback: cp '$BACKUP' '$CONFIG'"
test "$(python3 "$HERE/configure-autonomous-dev.py" --path "$CONFIG")" = "already configured"

NEW_CONFIG="$TMP/new config.toml"
NEW_OUTPUT=$(python3 "$HERE/configure-autonomous-dev.py" --path "$NEW_CONFIG")
test -f "$NEW_CONFIG"
printf '%s\n' "$NEW_OUTPUT" | grep -Fq 'backup: none (the config did not previously exist)'
printf '%s\n' "$NEW_OUTPUT" | grep -Fq "rollback: rm '$NEW_CONFIG'"

for KEY in sandbox_mode sandbox_workspace_write; do
  CONFLICT="$TMP/$KEY.toml"
  printf '%s = "conflict"\n' "$KEY" > "$CONFLICT"
  if python3 "$HERE/configure-autonomous-dev.py" --path "$CONFLICT" >/dev/null 2>&1; then
    echo "expected $KEY to be rejected" >&2
    exit 1
  fi
done

for CONTENT in \
  'approval_policy = "on-request"' \
  'default_permissions = "other"' \
  '[permissions.existing]'; do
  CONFLICT="$TMP/conflict.toml"
  printf '%s\n' "$CONTENT" > "$CONFLICT"
  if python3 "$HERE/configure-autonomous-dev.py" --path "$CONFLICT" >/dev/null 2>&1; then
    echo "expected conflicting configuration to be rejected" >&2
    exit 1
  fi
done

INVALID="$TMP/invalid.toml"
printf 'not valid =\n' > "$INVALID"
if python3 "$HERE/configure-autonomous-dev.py" --path "$INVALID" >/dev/null 2>&1; then
  echo "expected invalid TOML to be rejected" >&2
  exit 1
fi

echo "codex autonomous-dev tests passed"
