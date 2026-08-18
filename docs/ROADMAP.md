# Control Room roadmap

## Telemetry and reproducibility

- OpenTelemetry is the preferred common vendor-neutral capture/transport foundation; the first pilot captures Mac Codex logs, traces, and metrics into a bounded raw OTLP archive independently of MLflow.
- MLflow remains an optional downstream trace and evaluation consumer. Existing MLflow work is not replaced by capture.
- OpenObserve may later provide a lightweight query/UI layer over reconciled telemetry.
- A later server OTel deployment should use the same persistent node/source identity convention so Mac Codex and server Omnigent telemetry can coexist and be reconciled without rewriting native trace or span IDs.
- Daytona remains the reproducible workspace/snapshot layer. Harbor and Inspect remain later evaluation and replay layers.
