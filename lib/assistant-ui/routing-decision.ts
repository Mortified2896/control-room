import type { UIMessage } from "ai";

export const ROUTING_DECISION_MESSAGE_TYPE = "routing_decision" as const;
export const ROUTING_DECISION_PART_TYPE = "data-routing-decision" as const;

export type RoutingDecisionPayload = {
  messageType: typeof ROUTING_DECISION_MESSAGE_TYPE;
  includeInModelContext: false;
  auditId: string;
  route: "normal_chat" | "coding_task";
  harness?: string | null;
  routerEngine?: string | null;
  recommenderEngine?: string | null;
  recommenderReasoningLevel?: string | null;
  executionModel?: string | null;
  executionReasoningLevel?: string | null;
  fallback?: {
    configured?: boolean;
    attempted?: boolean;
    used?: boolean;
    engine?: string | null;
    reason?: string | null;
  } | null;
  whyRoute?: string | null;
  whyHarness?: string | null;
  whyModel?: string | null;
  alternatives?: Array<Record<string, unknown>>;
};

export function routingDecisionAuditId(input: {
  threadId?: string | null;
  prompt: string;
  route: string;
  executionModel?: string | null;
  harness?: string | null;
}) {
  return [
    "routing_decision",
    input.threadId ?? "local",
    input.route,
    input.harness ?? "none",
    input.executionModel ?? "none",
    input.prompt.trim(),
  ].join(":");
}

export function routingDecisionPart(payload: RoutingDecisionPayload) {
  return { type: ROUTING_DECISION_PART_TYPE, data: payload };
}

export function isRoutingDecisionPart(part: unknown): part is { type: typeof ROUTING_DECISION_PART_TYPE; data: RoutingDecisionPayload } {
  return Boolean(
    part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === ROUTING_DECISION_PART_TYPE &&
      (part as { data?: { messageType?: unknown; includeInModelContext?: unknown } }).data
        ?.messageType === ROUTING_DECISION_MESSAGE_TYPE &&
      (part as { data?: { includeInModelContext?: unknown } }).data?.includeInModelContext === false,
  );
}

export function routingDecisionFromMessage(message: { parts: readonly unknown[] }): RoutingDecisionPayload | null {
  for (const part of message.parts) {
    if (isRoutingDecisionPart(part)) return part.data;
  }
  return null;
}

export function isRoutingDecisionMessage(message: { parts: readonly unknown[] }): boolean {
  return routingDecisionFromMessage(message) != null;
}

export function filterModelContextMessages<T extends { parts: readonly unknown[] }>(messages: T[]): T[] {
  return messages.filter((message) => !isRoutingDecisionMessage(message));
}

export function formatRoutingDecisionMarkdown(payload: RoutingDecisionPayload): string {
  const lines = [
    "### Routing decision",
    "Saved for visibility only. Not sent to the execution model.",
    `- Route: ${payload.route === "coding_task" ? "coding" : "normal chat"}`,
    `- Harness: ${payload.harness ?? "none"}`,
    `- Router/recommender engine: ${payload.recommenderEngine ?? payload.routerEngine ?? "unknown"}`,
    `- Recommender reasoning level: ${payload.recommenderReasoningLevel ?? "unknown"}`,
    `- Execution model: ${payload.executionModel ?? "unknown"}`,
    `- Execution reasoning level: ${payload.executionReasoningLevel ?? "unknown"}`,
    `- Fallback recommender: ${payload.fallback?.used ? "used" : payload.fallback?.attempted ? "attempted" : payload.fallback?.configured ? "configured" : "not configured"}${payload.fallback?.engine ? ` (${payload.fallback.engine})` : ""}`,
  ];
  if (payload.whyRoute) lines.push(`\n**Why this route/harness**\n\n${payload.whyRoute}`);
  if (payload.whyHarness) lines.push(`\n**Why this harness**\n\n${payload.whyHarness}`);
  if (payload.whyModel) lines.push(`\n**Why this model**\n\n${payload.whyModel}`);
  if (payload.alternatives?.length) {
    lines.push("\n**Alternatives returned**");
    for (const alt of payload.alternatives) lines.push(`- ${JSON.stringify(alt)}`);
  }
  return lines.join("\n");
}
