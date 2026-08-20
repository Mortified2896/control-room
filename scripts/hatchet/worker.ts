import { startPilotTelemetry } from "../../lib/orchestration/hatchet/telemetry";

async function main(): Promise<void> {
  const telemetry = startPilotTelemetry({
    serviceName: "control-room-hatchet-worker",
    serviceVersion: "1.28.2",
    endpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  });

  try {
    const { agentJobTask, hatchet, timeoutProbeTask } =
      await import("../../lib/orchestration/hatchet/runtime");
    const workerName = process.env.HATCHET_PILOT_WORKER_NAME ?? "control-room-hatchet-pilot-worker";
    const worker = await hatchet.worker(workerName, {
      workflows: [agentJobTask, timeoutProbeTask],
      slots: Number(process.env.HATCHET_PILOT_WORKER_SLOTS ?? "2"),
      handleKill: false,
    });

    const started = worker.start();
    await worker.waitUntilReady(20_000);

    await started;
  } finally {
    await telemetry.shutdown();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `worker startup failed: ${error instanceof Error ? error.name : "unknown"}\n`,
  );
  process.exitCode = 1;
});
