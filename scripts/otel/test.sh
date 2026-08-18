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
python3 - "$TMP/config.toml" <<'PY'
import sys, tomllib
p = sys.argv[1]
cfg = tomllib.load(open(p, 'rb'))
for line in open(p):
    assert not line.startswith('+'), 'diff marker leaked into generated config'
assert cfg['model'] == 'keep-me', 'unrelated setting not preserved'
otel = cfg['otel']
assert otel['environment'] == 'mac-local'
assert otel['log_user_prompt'] is False
assert otel['exporter']['otlp-http'] == {'endpoint': 'http://127.0.0.1:4318/v1/logs', 'protocol': 'binary'}
assert otel['trace_exporter']['otlp-http'] == {'endpoint': 'http://127.0.0.1:4318/v1/traces', 'protocol': 'binary'}
assert otel['metrics_exporter']['otlp-http'] == {'endpoint': 'http://127.0.0.1:4318/v1/metrics', 'protocol': 'binary'}
print('generated config.toml parses cleanly')
PY
grep -q 'model = "keep-me"' "$TMP/config.toml"; grep -q 'log_user_prompt = false' "$TMP/config.toml"
[ "$(python3 "$HERE/control_room_otel.py" configure --path "$TMP/config.toml")" = unchanged ]
[ -n "$(ls "$TMP"/config.toml.backup-* 2>/dev/null | head -n1)" ]
printf '[otel]\nexporter = "none"\n' > "$TMP/conflict.toml"
! python3 "$HERE/control_room_otel.py" configure --path "$TMP/conflict.toml" >/dev/null 2>&1
printf '[otel]\n+environment = "mac-local"\nlog_user_prompt = false\n' > "$TMP/corrupt.toml"
python3 "$HERE/control_room_otel.py" configure --path "$TMP/corrupt.toml" >/dev/null
python3 -c 'import sys,tomllib; d=tomllib.load(open(sys.argv[1],"rb")); assert d["otel"]["log_user_prompt"] is False' "$TMP/corrupt.toml"
! grep -q '^+' "$TMP/corrupt.toml"
python3 "$HERE/control_room_otel.py" rollback --path "$TMP/config.toml" >/dev/null
grep -q 'model = "keep-me"' "$TMP/config.toml"; ! grep -q '\[otel\]' "$TMP/config.toml"
mkdir -p "$TMP/otel/data/logs"; printf '{bad json}\n' > "$TMP/otel/data/logs/logs.otlp.json"
CONTROL_ROOM_OTEL_HOME="$TMP/otel" python3 "$HERE/control_room_otel.py" check --since 1h --json > "$TMP/malformed.json" 2>/dev/null || true
grep -q '"malformed": 1' "$TMP/malformed.json"
echo "tests passed"
