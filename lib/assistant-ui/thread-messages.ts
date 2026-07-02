import type { UIMessage } from "ai";
import type { MessageRow } from "@/lib/repo/types";

function isPartsArray(parts: unknown): parts is UIMessage["parts"] {
  return Array.isArray(parts);
}

function contentToTextPart(content: string | null | undefined): UIMessage["parts"] {
  const text = content ?? "";
  return text ? [{ type: "text", text }] : [];
}

export function messageRowsToUIMessages(rows: MessageRow[]): UIMessage[] {
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    parts: isPartsArray(row.parts) ? row.parts : contentToTextPart(row.content),
  }));
}

export function uiMessageText(message: Pick<UIMessage, "parts">): string {
  if (!message.parts || !Array.isArray(message.parts)) return "";
  return message.parts
    .filter(
      (part): part is Extract<UIMessage["parts"][number], { type: "text" }> => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function extractLatestUserMessage(messages: UIMessage[]): UIMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "user") return message;
  }
  return null;
}

export function titleFromUserMessage(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "New chat";
  return normalized.length > 60 ? `${normalized.slice(0, 57)}…` : normalized;
}
