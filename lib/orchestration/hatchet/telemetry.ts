import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { HatchetInstrumentor, OTelAttribute } from "@hatchet-dev/typescript-sdk/opentelemetry";

export type PilotTelemetry = {
  tracer: ReturnType<typeof trace.getTracer>;
  shutdown: () => Promise<void>;
};

export function startPilotTelemetry(options: {
  serviceName: string;
  serviceVersion: string;
  endpoint?: string;
}): PilotTelemetry {
  const spanProcessors = options.endpoint
    ? [
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: options.endpoint,
          }),
        ),
      ]
    : [];

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion,
      "deployment.environment.name": "hatchet-pilot",
      "control_room.telemetry.profile": "metadata-only",
    }),
    spanProcessors,
  });
  provider.register();

  const unregister = registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new HatchetInstrumentor({
        enabled: false,
        enableHatchetCollector: false,
        includeTaskNameInSpanName: true,
        excludedAttributes: [OTelAttribute.ACTION_PAYLOAD, OTelAttribute.ADDITIONAL_METADATA],
      }),
    ],
  });

  return {
    tracer: trace.getTracer("control-room-hatchet-pilot", options.serviceVersion),
    shutdown: async () => {
      unregister();
      await provider.shutdown();
    },
  };
}
