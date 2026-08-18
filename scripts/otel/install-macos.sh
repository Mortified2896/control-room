#!/bin/sh
set -eu
VERSION=0.159.0
SHA_ARM64=7e317b75b1b087ba2150bf95d79e39a394d0d091f1231af6bbebee895d200375
SHA_AMD64=c683fc414117b8477794dcd7591e84e61cbef1e2ff8817afb6fd622e7fb5c0d9
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
OTEL_HOME=${CONTROL_ROOM_OTEL_HOME:-"$HOME/Library/Application Support/ControlRoom/otel"}
ARCH=$(uname -m)
case "$ARCH" in arm64) ASSET_ARCH=arm64; EXPECTED=$SHA_ARM64;; x86_64) ASSET_ARCH=amd64; EXPECTED=$SHA_AMD64;; *) echo "unsupported architecture: $ARCH" >&2; exit 1;; esac
for d in bin config data/logs data/traces data/metrics state collector-logs; do mkdir -p "$OTEL_HOME/$d"; done
chmod 700 "$OTEL_HOME" "$OTEL_HOME/state"
[ -s "$OTEL_HOME/state/capture_node_id" ] || (umask 077; uuidgen | tr '[:upper:]' '[:lower:]' > "$OTEL_HOME/state/capture_node_id")
NODE_ID=$(tr -d '\r\n' < "$OTEL_HOME/state/capture_node_id")
TMP=$(mktemp -d)
case "$TMP" in /tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*) ;; *) echo "unsafe temporary path" >&2; exit 1;; esac
trap 'test -n "${TMP:-}" && rm -rf "${TMP:?}"' EXIT HUP INT TERM
ASSET="otelcol-contrib_${VERSION}_darwin_${ASSET_ARCH}.tar.gz"
curl --proto '=https' --tlsv1.2 -fsSLo "$TMP/$ASSET" "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${VERSION}/$ASSET"
ACTUAL=$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')
[ "$ACTUAL" = "$EXPECTED" ] || { echo "checksum mismatch" >&2; exit 1; }
tar -xzf "$TMP/$ASSET" -C "$TMP" otelcol-contrib
install -m 0755 "$TMP/otelcol-contrib" "$OTEL_HOME/bin/otelcol-contrib"
install -m 0644 "$ROOT/scripts/otel/config/otelcol-macos.yaml" "$OTEL_HOME/config/otelcol-macos.yaml"
PLIST="$HOME/Library/LaunchAgents/com.controlroom.otelcol.plist"; mkdir -p "$HOME/Library/LaunchAgents"
HOST=$(hostname -s)
sed -e "s|@@HOME@@|$OTEL_HOME|g" -e "s|@@NODE_ID@@|$NODE_ID|g" -e "s|@@HOSTNAME@@|$HOST|g" -e "s|@@VERSION@@|$VERSION|g" "$ROOT/scripts/otel/launchd/com.controlroom.otelcol.plist.template" > "$PLIST"
plutil -lint "$PLIST" >/dev/null
CONTROL_ROOM_OTEL_HOME="$OTEL_HOME" CONTROL_ROOM_CAPTURE_NODE_ID="$NODE_ID" CONTROL_ROOM_ENVIRONMENT=mac-local CONTROL_ROOM_SOURCE_ROLE=mac-codex CONTROL_ROOM_HOSTNAME="$HOST" CONTROL_ROOM_COLLECTOR_VERSION="$VERSION" "$OTEL_HOME/bin/otelcol-contrib" validate --config "$OTEL_HOME/config/otelcol-macos.yaml"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
i=0
while launchctl print "gui/$(id -u)/com.controlroom.otelcol" >/dev/null 2>&1; do
  i=$((i+1)); [ "$i" -lt 30 ] || { echo "timed out unloading existing LaunchAgent" >&2; exit 1; }; sleep 0.1
done
launchctl bootstrap "gui/$(id -u)" "$PLIST"
python3 "$ROOT/scripts/otel/control_room_otel.py" configure
echo "Installed Collector $VERSION at $OTEL_HOME; restart Codex to activate its new OTel config."
