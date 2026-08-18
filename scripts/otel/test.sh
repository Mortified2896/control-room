#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for f in "$HERE"/*.sh; do sh -n "$f"; done
plutil -lint "$HERE/launchd/com.controlroom.otelcol.plist.template" >/dev/null
grep -q '127.0.0.1:4317' "$HERE/config/otelcol-macos.yaml"
! grep -q '0.0.0.0' "$HERE/config/otelcol-macos.yaml"
grep -q 'max_megabytes: 16' "$HERE/config/otelcol-macos.yaml"
TMP=$(mktemp -d); trap 'test -n "${TMP:-}" && rm -rf "${TMP:?}"' EXIT HUP INT TERM
printf 'model = "keep-me"\n' > "$TMP/config.toml"
python3 "$HERE/control_room_otel.py" configure --path "$TMP/config.toml" >/dev/null
grep -q 'model = "keep-me"' "$TMP/config.toml"; grep -q 'log_user_prompt = false' "$TMP/config.toml"
[ "$(python3 "$HERE/control_room_otel.py" configure --path "$TMP/config.toml")" = unchanged ]
printf '[otel]\nexporter = "none"\n' > "$TMP/conflict.toml"
! python3 "$HERE/control_room_otel.py" configure --path "$TMP/conflict.toml" >/dev/null 2>&1
mkdir -p "$TMP/otel/data/logs"; printf '{bad json}\n' > "$TMP/otel/data/logs/logs.otlp.json"
CONTROL_ROOM_OTEL_HOME="$TMP/otel" python3 "$HERE/control_room_otel.py" check --since 1h --json > "$TMP/malformed.json" 2>/dev/null || true
grep -q '"malformed": 1' "$TMP/malformed.json"
echo "tests passed"
