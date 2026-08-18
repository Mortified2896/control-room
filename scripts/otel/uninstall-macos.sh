#!/bin/sh
set -eu
OTEL_HOME=${CONTROL_ROOM_OTEL_HOME:-"$HOME/Library/Application Support/ControlRoom/otel"}
DELETE_DATA=false; [ "${1:-}" = "--delete-data" ] && DELETE_DATA=true
launchctl bootout "gui/$(id -u)/com.controlroom.otelcol" 2>/dev/null || true
PLIST="$HOME/Library/LaunchAgents/com.controlroom.otelcol.plist"; [ ! -f "$PLIST" ] || rm "$PLIST"
for p in "$OTEL_HOME/bin" "$OTEL_HOME/config"; do [ ! -e "$p" ] || rm -rf "$p"; done
if $DELETE_DATA; then rm -rf "$OTEL_HOME/data" "$OTEL_HOME/state" "$OTEL_HOME/collector-logs"; else echo "Telemetry preserved at $OTEL_HOME"; fi
echo "Codex [otel] configuration was intentionally left in place; restore a timestamped config backup or edit it deliberately."
