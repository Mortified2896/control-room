# Local Codex OpenTelemetry capture on macOS

This pilot makes OpenTelemetry the vendor-neutral capture and transport foundation for Codex desktop telemetry. It stays on the Mac: Codex sends OTLP/HTTP to a user LaunchAgent, which writes a lean long-lived archive for logs, traces, and metrics plus a short-lived forensic trace tier. MLflow is not required and remains a possible later trace/evaluation consumer.

The 60-day and 50 GB policies in this document apply **only to this local Mac Codex pilot**. They are not Control Room-wide defaults and do not apply to server telemetry, O1/O2, MLflow, OmniRoute, or any future server Collector. Any server adaptation requires separate volume and operational analysis.

## Install and operate

```bash
./scripts/otel/install-macos.sh
./scripts/otel/status.sh
./scripts/otel/check.sh --since 1h
./scripts/otel/check.sh --since 1h --json
python3 scripts/otel/control_room_otel.py retain --dry-run
```

The installer supports Apple Silicon and Intel, pins `otelcol-contrib` 0.159.0, verifies the official SHA-256 (`7e317b…00375` for arm64; `c683fc…5c0d9` for amd64), creates one persistent `capture_node_id`, validates the config, installs the Collector and retention LaunchAgents, and merges the OTel block into `~/.codex/config.toml`. The merge validates the complete resulting TOML before writing, writes atomically, and first saves a UTC timestamped backup (`config.toml.backup-<timestamp>`) so the previous state is always recoverable. It refuses any pre-existing non-identical `[otel]` block, except the known `+`-prefixed corruption described below, which it repairs in place. Restart Codex fully after the first install.

`control_room_otel.py` also has a `rollback` subcommand. It restores the latest timestamped backup (or a specific one with `--backup`), saving the current file as `config.toml.pre-rollback-<timestamp>` first so the rollback itself is reversible:

```bash
python3 scripts/otel/control_room_otel.py rollback --list
python3 scripts/otel/control_room_otel.py rollback
```

Runtime is under `~/Library/Application Support/ControlRoom/otel/`. OTLP gRPC `127.0.0.1:4317`, OTLP HTTP `127.0.0.1:4318`, Collector metrics `127.0.0.1:8888`, and health `127.0.0.1:13133` never bind publicly.

The installer also starts `com.controlroom.otel-retention` every five minutes. This independent LaunchAgent applies age and aggregate-size retention across the complete Mac Codex telemetry data directory; per-exporter backup counts are only a secondary safety bound, not the implementation of the global ceiling.

## Lean and forensic tiers

The data layout is:

```text
data/
├── lean/
│   ├── logs/
│   ├── traces/
│   └── metrics/
└── forensic/
    └── traces/
```

The lean archive is the durable Control Room source. It keeps native trace, span, and parent IDs and timestamps; Codex conversation/turn identifiers; actual model/provider and reasoning metadata; token usage; tool identity, duration, and success; sandbox outcome; errors/status; app/service version; and Control Room source identity when Codex emits them.

The lean trace pipeline drops:

- every `receiving`, `append_items`, and `persist_rollout_items` span;
- a `handle_responses` span only when it has exactly the nine observed boilerplate attributes, has no span events, and is not error status.

That exact-count guard deliberately retains `handle_responses` carrying any additional metadata. In the measured archive it protected token usage, `from`, and `tool_name` variants and all parents of meaningful retained children. The test fixture also proves that event-bearing and error-status variants remain.

The lean trace pipeline deletes free-text `error.message` from both span attributes and
span-event attributes, while retaining error-status spans and structured failure metadata such
as error type/category, status, outcome, and HTTP status where emitted. It also deletes integer
runtime-thread IDs and these implementation attributes:

- `code.file.path`
- `code.module.name`
- `code.line.number`
- `thread.name`
- `target`
- `busy_ns`
- `idle_ns`

Codex also uses string-valued `thread.id` on session/turn spans. Those values are preserved; only integer runtime-thread values are removed. `codex.request.reasoning_effort` is preserved because it is the only reasoning field on retained `handle_responses` spans.

The lean log pipeline removes `arguments`, `output`, `user.email`, `user.account_id`, and
free-text `error.message`. It retains event type, conversation ID, model, tool name, duration,
success/outcome, token counts, TTFT, reasoning configuration, sandbox policy/outcome, and HTTP
status where emitted. There is intentionally no raw log tier because current Codex logs can
contain complete tool arguments and outputs.

The forensic tier contains unfiltered traces only. It exists for instrumentation debugging and filter validation, not long-term analytics. It has a three-day maximum age and an independent 4,000,000,000-byte ceiling inside the global ceiling.

## Mac-only retention and storage status

Lean and legacy Mac Codex telemetry has a maximum age of 60 days. The complete `data/` archive has an aggregate ceiling of exactly 50,000,000,000 bytes, with the oldest recognized rotated file removed first when size pruning is necessary. Whichever limit is reached first wins. The 50 GB value is a safety ceiling, not a storage target.

The retention implementation:

- counts every regular, non-symlink file under the Mac Codex `data/` directory toward the global ceiling;
- deletes only recognized rotated Codex telemetry names;
- never deletes the four configured active files;
- refuses CLI retention roots outside the configured Mac archive;
- rejects symlinks and paths that resolve outside the archive;
- verifies inode, size, and modification time again immediately before deletion;
- prunes by age, then the forensic sub-ceiling, then the global ceiling;
- fails nonzero if protected/unrecognized files prevent convergence;
- is idempotent and records its last result under `state/retention-last-run.json`.

The Collector still rotates each file at 16 MiB. Its per-exporter backup caps sum to less than the 50 GB aggregate limit, providing a fallback bound if scheduled cleanup is interrupted. The deterministic retention command is what enforces the cross-signal aggregate policy.

`status.sh` and `check.sh --json` report total/log/trace/metric/forensic bytes, rotated-file count, oldest retained file and time, configured age and size limits, percentage used, and an approximate recent bytes/hour indicator. The growth rate uses files modified in the requested `--since` window and is an operational approximation, not billing-grade accounting.

## Compression and readback

Collector 0.159.0 supports `zstd`, but standard file-level `.zst` output requires the alpha `exporter.file.nativeCompression` feature gate. A controlled test produced a standard Zstandard file, passed `zstd -t`, and round-tripped OTLP JSON successfully. The pilot does not enable that alpha gate: filtering already reduced the representative trace archive by about 90%, while uncompressed newline-delimited JSON remains directly inspectable by the current status tooling and `otlp_json_file` receiver.

Revisit native compression when the feature gate is no longer alpha or after a separate operational decision accepts the compatibility cost. Do not enable legacy per-message compression expecting an ordinary `.zst` file; it uses length-framed messages and requires Collector-aware readback.

## Measured filter baseline

On 2026-08-18, a stable copy of 14 real trace files was replayed through the exact pinned Collector and production OTTL pipeline:

| Measurement | Before | Lean result | Reduction |
| --- | ---: | ---: | ---: |
| File bytes | 217,532,058 | 21,697,734 | 90.03% |
| Spans | 268,831 | 53,432 | 80.12% |

The run removed 77,185 `receiving`, 74,885 low-value `handle_responses`, 40,108 `append_items`, and 23,221 `persist_rollout_items` spans. It retained 2,300 metadata-bearing `handle_responses`, including all 458 token-bearing instances. Every retained span kept its original trace ID, span ID, and parent span ID; no newly orphaned retained edges were observed. Model, provider, reasoning, token, tool, turn/session, HTTP status, error type, app version, service version, and Control Room capture identity fields remained present.

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

`log_user_prompt = false` is enforced by default. In the measured archive all 128 `prompt`
attributes were the ten-character redaction marker, not prompt content. Prompt events can still
identify that a prompt happened and its length. Enabling prompt content is deliberately
unsupported by the installer. Tool arguments/outputs, personal account identifiers, and
free-text error messages in logs, spans, and span events are also removed from the lean archive
as described above. Structured failure metadata remains available for analysis. This statement
applies to telemetry processed by the current lean pipeline; legacy and forensic files have the
separate handling described in this document.

Files in the legacy `data/logs`, `data/traces`, and `data/metrics` directories predate the lean pipeline. They are retained unchanged to honor the no-data-deletion migration rule and remain subject to the 60-day/global-size policy. Treat legacy logs as sensitive because older Codex records can contain tool arguments, outputs, and account identifiers. The Collector no longer writes those paths; do not use them as the durable analytical source.

A future server Collector should use the same keys with a persistent server node ID and a distinct role such as `server-omnigent`. Native trace/span IDs remain untouched, so independent `mac-codex / mac-A / trace X` and `server-omnigent / server-B / trace Y` records can coexist and later be reconciled by explicit correlation metadata.

## Uninstall

`./scripts/otel/uninstall-macos.sh` unloads both LaunchAgents and removes the installed binary/config while preserving data, state, and logs. `--delete-data` explicitly deletes them. Codex config is left untouched so uninstall cannot accidentally remove unrelated TOML; restore the installer-created backup or edit the OTel block deliberately.

Both tiers are standard uncompressed OTLP JSON, one export request per line, suitable for direct readback with the pinned Collector's `otlp_json_file` receiver and for a later normalizer to Parquet and DuckDB. File-exporter field names are currently alpha and may evolve; pinning the Collector makes each installation reproducible.
