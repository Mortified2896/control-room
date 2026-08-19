import type { UIMessage } from "ai";

export const ROUTING_DECISION_MESSAGE_TYPE = "routing_decision" as const;
export const ROUTING_DECISION_PART_TYPE = "data-routing-decision" as const;
export const ROUTING_DECISION_MESSAGE_KIND = "routing_decision" as const;

export type RoutingDecisionPayload = {
  kind: typeof ROUTING_DECISION_MESSAGE_KIND;
  messageType: typeof ROUTING_DECISION_MESSAGE_TYPE;
  includeInModelContext: false;
  auditId: string;
  route: "normal_chat" | "coding_task";
  selectionSource?: "manual_current_selection" | "recommender_output" | "manual_override" | string | null;
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

/**
 * Shape of the message-level metadata stored on routing-decision assistant
 * messages. The client uses this to filter routing decisions out of model
 * context, even before parts have been parsed, and to render the dedicated
 * `RoutingDecisionCard` instead of the normal text parts.
 *
 * The same fields are also encoded in the `data-routing-decision` data
 * part payload, so on reload the routing decision is still identifiable
 * even though the messages table does not have a dedicated `metadata`
 * column.
 */
export type RoutingDecisionMessageMetadata = {
  custom: {
    kind: typeof ROUTING_DECISION_MESSAGE_KIND;
    messageType: typeof ROUTING_DECISION_MESSAGE_TYPE;
    includeInModelContext: false;
    auditId: string;
    routingDecision: RoutingDecisionPayload;
  };
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

export function routingDecisionTextPart(payload: RoutingDecisionPayload) {
  return { type: "text" as const, text: formatRoutingDecisionMarkdown(payload) };
}

/**
 * Build the message-level metadata that tags a routing-decision assistant
 * message. The client uses this to filter routing decisions out of model
 * context and to render the `RoutingDecisionCard`. The same payload is
 * also encoded in the `data-routing-decision` data part for durability
 * (the messages table does not have a dedicated `metadata` column).
 */
export function routingDecisionMessageMetadata(payload: RoutingDecisionPayload): RoutingDecisionMessageMetadata {
  return {
    custom: {
      kind: ROUTING_DECISION_MESSAGE_KIND,
      messageType: payload.messageType,
      includeInModelContext: false,
      auditId: payload.auditId,
      routingDecision: payload,
    },
  };
}

export function isRoutingDecisionPart(part: unknown): part is { type: typeof ROUTING_DECISION_PART_TYPE; data: RoutingDecisionPayload } {
  return Boolean(
    part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === ROUTING_DECISION_PART_TYPE &&
      (part as { data?: { kind?: unknown; messageType?: unknown; includeInModelContext?: unknown } }).data
        ?.kind === ROUTING_DECISION_MESSAGE_KIND &&
      (part as { data?: { messageType?: unknown } }).data?.messageType === ROUTING_DECISION_MESSAGE_TYPE &&
      (part as { data?: { includeInModelContext?: unknown } }).data?.includeInModelContext === false,
  );
}

export function routingDecisionFromMessage(message: { parts?: readonly unknown[] }): RoutingDecisionPayload | null {
  if (!message.parts || !Array.isArray(message.parts)) return null;
  for (const part of message.parts) {
    if (isRoutingDecisionPart(part)) return part.data;
  }
  return null;
}

/**
 * Returns the routing decision payload embedded in message-level metadata,
 * if any. This is the live-view fast path; on reload the payload is
 * recovered from the `data-routing-decision` data part instead, since the
 * messages table does not persist message metadata.
 */
export function routingDecisionFromMetadata(message: {
  metadata?: { custom?: { kind?: unknown; routingDecision?: unknown } } | null;
}): RoutingDecisionPayload | null {
  const custom = message.metadata?.custom;
  if (!custom || custom.kind !== ROUTING_DECISION_MESSAGE_KIND) return null;
  const payload = custom.routingDecision;
  if (!payload || typeof payload !== "object") return null;
  return payload as RoutingDecisionPayload;
}

/**
 * A message is a routing-decision audit bubble if any of the following
 * is true (checked in order):
 *   1. Message-level metadata `kind === "routing_decision"` (live view).
 *   2. A `data-routing-decision` data part is present in the message
 *      (live view + reload view).
 *   3. A text part contains the canonical "Saved for visibility only.
 *      Not sent to the execution model." footer together with the
 *      "Routing decision" header (legacy fallback).
 */
export function isRoutingDecisionMessage(message: {
  parts?: readonly unknown[];
  metadata?: unknown;
}): boolean {
  const metadataKind = (message.metadata as { custom?: { kind?: unknown } } | null | undefined)?.custom?.kind;
  if (metadataKind === ROUTING_DECISION_MESSAGE_KIND) return true;
  if (!message.parts || !Array.isArray(message.parts)) return false;
  if (routingDecisionFromMessage(message) != null) return true;
  return message.parts.some(
    (part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string" &&
      (part as { text: string }).text.includes("Saved for visibility only. Not sent to the execution model.") &&
      (part as { text: string }).text.includes("Routing decision"),
  );
}

export function filterModelContextMessages<T extends { parts?: readonly unknown[]; metadata?: unknown }>(messages: T[]): T[] {
  return messages.filter((message) => !isRoutingDecisionMessage(message));
}

export function formatRoutingDecisionMarkdown(payload: RoutingDecisionPayload): string {
  const lines = [
    "### Routing decision",
    "Saved for visibility only. Not sent to the execution model.",
    `- Route: ${payload.route === "coding_task" ? "coding" : "normal chat"}`,
    `- Selection source: ${payload.selectionSource ?? "unknown"}`,
    `- Harness: ${payload.harness ?? "none"}`,
    `- Router/recommender engine: ${payload.recommenderEngine ?? payload.routerEngine ?? "not used"}`,
    `- Recommender reasoning level: ${payload.recommenderReasoningLevel ?? "unknown"}`,
    `- Execution model: ${payload.executionModel ?? "unknown"}`,
    `- Execution reasoning level: ${payload.executionReasoningLevel ?? "unknown"}`,
    `- Fallback recommender: ${payload.fallback == null ? "not used" : payload.fallback.used ? "used" : payload.fallback.attempted ? "attempted" : payload.fallback.configured ? "configured" : "not configured"}${payload.fallback?.engine ? ` (${payload.fallback.engine})` : ""}`,
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
