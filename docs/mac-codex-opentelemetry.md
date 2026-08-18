# Local Codex OpenTelemetry capture on macOS

This pilot makes OpenTelemetry the vendor-neutral capture and transport foundation for Codex desktop telemetry. It stays on the Mac: Codex sends OTLP/HTTP to a user LaunchAgent, which writes separate newline-delimited OTLP JSON archives for logs, traces, and metrics. MLflow is not required and remains a possible later trace/evaluation consumer.

## Install and operate

```bash
./scripts/otel/install-macos.sh
./scripts/otel/status.sh
./scripts/otel/check.sh --since 1h
./scripts/otel/check.sh --since 1h --json
```

The installer supports Apple Silicon and Intel, pins `otelcol-contrib` 0.159.0, verifies the official SHA-256 (`7e317b…00375` for arm64; `c683fc…5c0d9` for amd64), creates one persistent `capture_node_id`, validates the config, installs `~/Library/LaunchAgents/com.controlroom.otelcol.plist`, and merges the OTel block into `~/.codex/config.toml`. The merge validates the complete resulting TOML before writing, writes atomically, and first saves a UTC timestamped backup (`config.toml.backup-<timestamp>`) so the previous state is always recoverable. It refuses any pre-existing non-identical `[otel]` block, except the known `+`-prefixed corruption described below, which it repairs in place. Restart Codex fully after the first install.

`control_room_otel.py` also has a `rollback` subcommand. It restores the latest timestamped backup (or a specific one with `--backup`), saving the current file as `config.toml.pre-rollback-<timestamp>` first so the rollback itself is reversible:

```bash
python3 scripts/otel/control_room_otel.py rollback --list
python3 scripts/otel/control_room_otel.py rollback
```

Runtime is under `~/Library/Application Support/ControlRoom/otel/`. OTLP gRPC `127.0.0.1:4317`, OTLP HTTP `127.0.0.1:4318`, Collector metrics `127.0.0.1:8888`, and health `127.0.0.1:13133` never bind publicly.

Each stream rotates at 16 MiB with 20 backups and a 14-day age limit, for a hard size ceiling near 1,008 MiB across the three streams (current file plus 20 backups each). Rotation filenames use UTC and files remain uncompressed/readable. Change all three `rotation` blocks together to adjust this.

## Supported `~/.codex/config.toml` schema

The installer merges exactly this `[otel]` block:

```toml
[otel]
environment = "mac-local"
log_user_prompt = false
exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "binary" } }
trace_exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/traces", protocol = "binary" } }
metrics_exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/metrics", protocol = "binary" } }
```

## Optional autonomous workspace development

Trusted local development on this Mac can opt in to a custom permission profile that keeps
filesystem writes scoped to each active workspace, makes that workspace's `.git` directory
writable, and enables development network access. This avoids routing ordinary commits and
pushes through Auto-review without using `danger-full-access`:

```bash
python3 scripts/codex/configure-autonomous-dev.py
```

This helper changes the user-level Codex defaults in `~/.codex/config.toml`: it sets
`approval_policy`, selects `autonomous-dev` as the default permission profile, and enables the
profile's network policy for future Codex sessions on this Mac until rolled back or changed.
Filesystem write access is still scoped by the sandbox to each session's active workspace roots;
it does not grant arbitrary writes elsewhere on the Mac.

The helper is deliberately opt-in. It refuses legacy `sandbox_mode` /
`sandbox_workspace_write` settings and conflicting permission profiles, validates the complete
TOML, creates `config.toml.backup-autonomous-dev-<UTC timestamp>` when a config already exists,
and replaces the config atomically. Existing model, authentication, plugin, and OTel settings are
retained. The command prints an exact one-command rollback (`cp` for an existing config or `rm`
when it created the config). Fully quit and reopen Codex after changing the profile.

The installed Codex version must support named permission profiles. The resulting profile extends
the built-in `:workspace` policy, overrides only `:workspace_roots/.git` to `write`, and allows all
network domains. Paths outside the active workspace remain restricted by the sandbox.

`environment`, `exporter`, `trace_exporter`, and `metrics_exporter` map to the Collector's OTLP HTTP receiver on `127.0.0.1:4318` (`/v1/logs`, `/v1/traces`, `/v1/metrics`) using the `binary` protocol. `log_user_prompt = false` is enforced by default; changing it to `true` is deliberately not supported by the merge (see the privacy section).

### Compatibility-testing caveat

These exporter keys are Codex-app-specific and are only exercised against the Collector receiver this repo configures. This repo does not ship an independent validation of Codex's own TOML schema, so the exact key names are pinned to a tested Codex version and can change across Codex releases. Before upgrading Codex, re-run `./scripts/otel/check.sh` and `status.sh`; if the desktop app stops reporting telemetry or flags the config, roll back with `control_room_otel.py rollback` and verify against the new Codex version before re-enabling.

The complete block above was verified on 2026-08-18 with ChatGPT/Codex desktop `26.810.52044` (build `6662`) and its bundled `codex-cli 0.148.0-alpha.9` on macOS 26.5.2 arm64. Each capability was enabled independently and the app was fully restarted between trials:

| Trial | Enabled configuration | Result |
| --- | --- | --- |
| A | `environment`, `log_user_prompt = false` | PASS: app, project task, and permission mode remained usable |
| B | A + logs exporter | PASS: real `codex-app-server` logs archived |
| C | B + trace exporter | PASS: real spans with native trace/span IDs archived |
| D | C + metrics exporter | PASS: real metric points archived after the exporter interval |

For a controlled retest, `test-stage` preserves the first known-good config as `config.toml.control-room-known-good`, saves each intermediate config, validates the merged TOML, and enables one stage at a time. `test-restore` restores the known-good checkpoint:

```bash
python3 scripts/otel/control_room_otel.py test-stage minimal
python3 scripts/otel/control_room_otel.py test-stage logs
python3 scripts/otel/control_room_otel.py test-stage traces
python3 scripts/otel/control_room_otel.py test-stage metrics
python3 scripts/otel/control_room_otel.py test-restore
```

## Known installer regression and recovery

A previous installer version wrote the `[otel]` block with literal `+` diff-marker prefixes (for example `+environment = "mac-local"`). A leading `+` is not valid TOML, so `~/.codex/config.toml` failed to parse at the first OTel key and the Codex desktop app reported `Permission mode is unavailable`.

Recovery options:

- Re-run `./scripts/otel/install-macos.sh` — `configure` detects the `+`-prefixed block and repairs it in place, after a timestamped backup.
- Restore a timestamped backup: `python3 scripts/otel/control_room_otel.py rollback`.
- Manually delete the leading `+` from each OTel line in `~/.codex/config.toml`.

After recovering, restart Codex fully and confirm with `./scripts/otel/check.sh --since 1h`.

## Identity and privacy

The Collector adds `deployment.environment.name=mac-local`, `controlroom.source.role=mac-codex`, `host.name`, `os.type=darwin`, `controlroom.capture_node_id`, and Collector version without rewriting native trace/span IDs or timestamps. Codex supplies its service/version, conversation ID, model, reasoning, and other event metadata when available.

`log_user_prompt = false` is enforced by default. Prompt events can still identify that a prompt happened and its length, but the content is redacted. For deliberate research/replay only, change it to `true` after reviewing who can read the archive: prompts may contain secrets, personal data, customer data, or proprietary code. Restart Codex afterward and reduce retention as appropriate.

A future server Collector should use the same keys with a persistent server node ID and a distinct role such as `server-omnigent`. Native trace/span IDs remain untouched, so independent `mac-codex / mac-A / trace X` and `server-omnigent / server-B / trace Y` records can coexist and later be reconciled by explicit correlation metadata.

## Uninstall

`./scripts/otel/uninstall-macos.sh` unloads the service and removes its binary/config while preserving data, state, and logs. `--delete-data` explicitly deletes them. Codex config is left untouched so uninstall cannot accidentally remove unrelated TOML; restore the installer-created backup or edit the OTel block deliberately.

The archive is standard OTLP JSON, one export request per line, suitable for a later normalizer to Parquet and DuckDB. File-exporter field names are currently alpha and may evolve; pinning the Collector makes each installation reproducible.
