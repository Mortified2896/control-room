# Local Codex OpenTelemetry capture on macOS

This pilot makes OpenTelemetry the vendor-neutral capture and transport foundation for Codex desktop telemetry. It stays on the Mac: Codex sends OTLP/HTTP to a user LaunchAgent, which writes separate newline-delimited OTLP JSON archives for logs, traces, and metrics. MLflow is not required and remains a possible later trace/evaluation consumer.

## Install and operate

```bash
./scripts/otel/install-macos.sh
./scripts/otel/status.sh
./scripts/otel/check.sh --since 1h
./scripts/otel/check.sh --since 1h --json
```

The installer supports Apple Silicon and Intel, pins `otelcol-contrib` 0.159.0, verifies the official SHA-256 (`7e317b…00375` for arm64; `c683fc…5c0d9` for amd64), creates one persistent `capture_node_id`, validates the config, installs `~/Library/LaunchAgents/com.controlroom.otelcol.plist`, and merges the OTel block into `~/.codex/config.toml` after a UTC timestamped backup. It refuses any pre-existing non-identical `[otel]` block. Restart Codex fully after the first install.

Runtime is under `~/Library/Application Support/ControlRoom/otel/`. OTLP gRPC `127.0.0.1:4317`, OTLP HTTP `127.0.0.1:4318`, Collector metrics `127.0.0.1:8888`, and health `127.0.0.1:13133` never bind publicly.

Each stream rotates at 16 MiB with 20 backups and a 14-day age limit, for a hard size ceiling near 1,008 MiB across the three streams (current file plus 20 backups each). Rotation filenames use UTC and files remain uncompressed/readable. Change all three `rotation` blocks together to adjust this.

## Identity and privacy

The Collector adds `deployment.environment.name=mac-local`, `controlroom.source.role=mac-codex`, `host.name`, `os.type=darwin`, `controlroom.capture_node_id`, and Collector version without rewriting native trace/span IDs or timestamps. Codex supplies its service/version, conversation ID, model, reasoning, and other event metadata when available.

`log_user_prompt = false` is enforced by default. Prompt events can still identify that a prompt happened and its length, but the content is redacted. For deliberate research/replay only, change it to `true` after reviewing who can read the archive: prompts may contain secrets, personal data, customer data, or proprietary code. Restart Codex afterward and reduce retention as appropriate.

A future server Collector should use the same keys with a persistent server node ID and a distinct role such as `server-omnigent`. Native trace/span IDs remain untouched, so independent `mac-codex / mac-A / trace X` and `server-omnigent / server-B / trace Y` records can coexist and later be reconciled by explicit correlation metadata.

## Uninstall

`./scripts/otel/uninstall-macos.sh` unloads the service and removes its binary/config while preserving data, state, and logs. `--delete-data` explicitly deletes them. Codex config is left untouched so uninstall cannot accidentally remove unrelated TOML; restore the installer-created backup or edit the OTel block deliberately.

The archive is standard OTLP JSON, one export request per line, suitable for a later normalizer to Parquet and DuckDB. File-exporter field names are currently alpha and may evolve; pinning the Collector makes each installation reproducible.
