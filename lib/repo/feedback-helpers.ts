import type { MessageRating } from "./types";

export function isMessageRating(value: unknown): value is MessageRating {
  return value === "up" || value === "down";
}

export function normalizeThreadNoteBody(body: string): string {
  return body.trim().slice(0, 5_000);
}

export function threadNotesAreChatContext(): false {
  return false;
}
