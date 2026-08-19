#!/usr/bin/env python3
"""Exercise the production OTTL and privacy rules with the pinned Collector."""
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def kv(key, value):
    kind = "intValue" if isinstance(value, int) else "stringValue"
    return {"key": key, "value": {kind: value}}


def boilerplate():
    return [
        kv("code.file.path", "internal.rs"), kv("code.module.name", "internal"),
        kv("code.line.number", 1), kv("thread.id", 7), kv("thread.name", "worker"),
        kv("target", "internal"), kv("busy_ns", 1), kv("idle_ns", 2),
        kv("codex.request.reasoning_effort", "high"),
    ]


def span(number, name, attributes=None, **extra):
    item = {
        "traceId": "00112233445566778899aabbccddeeff",
        "spanId": f"{number:016x}", "name": name,
        "startTimeUnixNano": "1000000000", "endTimeUnixNano": "2000000000",
        "attributes": attributes or boilerplate(),
    }
    item.update(extra)
    return item


def main():
    collector = Path(sys.argv[1])
    with tempfile.TemporaryDirectory() as temp_name:
        temp = Path(temp_name); inputs = temp / "input"; output = temp / "output"
        inputs.mkdir(); output.mkdir()
        spans = [
            span(1, "receiving"), span(2, "append_items"), span(3, "persist_rollout_items"),
            span(4, "handle_responses"),
            span(5, "handle_responses", boilerplate() + [kv("gen_ai.usage.input_tokens", 10)]),
            span(6, "handle_responses", boilerplate() + [kv("from", "model")]),
            span(7, "handle_responses", events=[{
                "name": "valuable", "timeUnixNano": "1500000000",
                "attributes": [
                    kv("error.message", "sensitive event error"),
                    kv("error.type", "event_failure"),
                    kv("error.category", "tool"),
                ],
            }]),
            span(8, "handle_responses", boilerplate() + [
                kv("error.message", "sensitive span error"),
                kv("error.type", "request_failure"),
                kv("error.category", "transport"),
                kv("http.response.status_code", 503),
                kv("outcome", "failure"),
            ], status={"code": 2}),
            span(9, "session_task.turn", boilerplate() + [kv("thread.id", "session-id"), kv("turn.id", "turn-id"), kv("model", "test-model")]),
        ]
        trace_request = {"resourceSpans": [{"resource": {"attributes": [kv("service.name", "filter-test")]}, "scopeSpans": [{"scope": {"name": "test"}, "spans": spans}]}]}
        (inputs / "traces.json").write_text(json.dumps(trace_request) + "\n")
        log_attributes = [
            kv("event.name", "codex.tool_result"), kv("conversation.id", "session-id"),
            kv("model", "test-model"), kv("tool_name", "shell"), kv("duration_ms", 5),
            kv("success", "true"), kv("outcome", "allowed"), kv("prompt", "[REDACTED]"),
            kv("arguments", "sensitive argument"), kv("output", "sensitive output"),
            kv("user.email", "private@example.invalid"), kv("user.account_id", "private-id"),
            kv("error.message", "sensitive error"),
        ]
        log_request = {"resourceLogs": [{"resource": {"attributes": [kv("service.name", "filter-test")]}, "scopeLogs": [{"scope": {"name": "test"}, "logRecords": [{"timeUnixNano": "1000000000", "attributes": log_attributes}]}]}]}
        (inputs / "logs.json").write_text(json.dumps(log_request) + "\n")
        config = f'''receivers:
  otlp_json_file/traces: {{include: ["{inputs}/traces.json"], start_at: beginning}}
  otlp_json_file/logs: {{include: ["{inputs}/logs.json"], start_at: beginning}}
processors:
  attributes/replay_input:
    actions: [{{key: log.file.name, action: delete}}]
  filter/lean_traces:
    error_mode: propagate
    trace_conditions:
      - context: span
        conditions:
          - 'span.name == "receiving"'
          - 'span.name == "append_items"'
          - 'span.name == "persist_rollout_items"'
          - 'span.name == "handle_responses" and Len(span.attributes) == 9 and Len(span.events) == 0 and span.status.code != STATUS_CODE_ERROR'
  transform/lean_traces:
    error_mode: propagate
    trace_statements:
      - context: span
        statements:
          - 'delete_key(span.attributes, "thread.id") where IsInt(span.attributes["thread.id"])'
          - 'delete_key(span.attributes, "error.message")'
      - context: spanevent
        statements:
          - 'delete_key(spanevent.attributes, "error.message")'
  attributes/lean_traces:
    actions:
      - {{key: code.file.path, action: delete}}
      - {{key: code.module.name, action: delete}}
      - {{key: code.line.number, action: delete}}
      - {{key: thread.name, action: delete}}
      - {{key: target, action: delete}}
      - {{key: busy_ns, action: delete}}
      - {{key: idle_ns, action: delete}}
  attributes/privacy_logs:
    actions:
      - {{key: arguments, action: delete}}
      - {{key: output, action: delete}}
      - {{key: user.email, action: delete}}
      - {{key: user.account_id, action: delete}}
      - {{key: error.message, action: delete}}
exporters:
  file/traces: {{path: "{output}/traces.json", format: json}}
  file/logs: {{path: "{output}/logs.json", format: json}}
service:
  telemetry: {{metrics: {{level: none}}}}
  pipelines:
    traces: {{receivers: [otlp_json_file/traces], processors: [attributes/replay_input, filter/lean_traces, transform/lean_traces, attributes/lean_traces], exporters: [file/traces]}}
    logs: {{receivers: [otlp_json_file/logs], processors: [attributes/replay_input, attributes/privacy_logs], exporters: [file/logs]}}
'''
        config_path = temp / "collector.yaml"; config_path.write_text(config)
        process = subprocess.Popen([str(collector), "--config", str(config_path)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        try:
            last = None
            for _ in range(100):
                sizes = tuple(p.stat().st_size if p.exists() else 0 for p in (output / "traces.json", output / "logs.json"))
                if min(sizes) > 0 and sizes == last: break
                last = sizes; time.sleep(0.05)
            else: raise AssertionError("Collector fixture output did not stabilize")
        finally:
            process.send_signal(signal.SIGINT)
            _, stderr = process.communicate(timeout=5)
        if process.returncode != 0: raise AssertionError(stderr)

        trace_rows = [json.loads(line) for line in (output / "traces.json").open()]
        kept = [s for row in trace_rows for rs in row["resourceSpans"] for ss in rs["scopeSpans"] for s in ss["spans"]]
        names = [s["name"] for s in kept]
        assert names.count("handle_responses") == 4 and names.count("session_task.turn") == 1, names
        session = next(s for s in kept if s["name"] == "session_task.turn")
        attrs = {a["key"]: a["value"] for a in session.get("attributes", [])}
        assert attrs["thread.id"] == {"stringValue": "session-id"}
        assert attrs["turn.id"] == {"stringValue": "turn-id"}
        for key in ("code.file.path", "code.module.name", "code.line.number", "thread.name", "target", "busy_ns", "idle_ns"):
            assert key not in attrs

        error_span = next(s for s in kept if s.get("status", {}).get("code") == 2)
        error_attrs = {a["key"]: a["value"] for a in error_span.get("attributes", [])}
        assert "error.message" not in error_attrs
        assert error_span["status"] == {"code": 2}
        assert error_attrs["error.type"] == {"stringValue": "request_failure"}
        assert error_attrs["error.category"] == {"stringValue": "transport"}
        assert error_attrs["http.response.status_code"] == {"intValue": "503"}
        assert error_attrs["outcome"] == {"stringValue": "failure"}

        event_span = next(s for s in kept if s.get("events"))
        event = next(e for e in event_span["events"] if e["name"] == "valuable")
        event_attrs = {a["key"]: a["value"] for a in event.get("attributes", [])}
        assert "error.message" not in event_attrs
        assert event_attrs["error.type"] == {"stringValue": "event_failure"}
        assert event_attrs["error.category"] == {"stringValue": "tool"}

        log_rows = [json.loads(line) for line in (output / "logs.json").open()]
        record = next(r for row in log_rows for rl in row["resourceLogs"] for sl in rl["scopeLogs"] for r in sl["logRecords"])
        attrs = {a["key"]: a["value"] for a in record.get("attributes", [])}
        for key in ("arguments", "output", "user.email", "user.account_id", "error.message"):
            assert key not in attrs
        for key in ("event.name", "conversation.id", "model", "tool_name", "duration_ms", "success", "outcome"):
            assert key in attrs
        assert attrs["prompt"] == {"stringValue": "[REDACTED]"}
        print("Collector filtering/privacy fixture passed")


if __name__ == "__main__":
    main()
