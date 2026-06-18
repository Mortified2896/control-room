import assert from "node:assert/strict";
import test from "node:test";

import {
  isMessageRating,
  normalizeThreadNoteBody,
  threadNotesAreChatContext,
} from "./feedback-helpers.ts";

test("isMessageRating only accepts up/down", () => {
  assert.equal(isMessageRating("up"), true);
  assert.equal(isMessageRating("down"), true);
  assert.equal(isMessageRating("good"), false);
  assert.equal(isMessageRating(null), false);
});

test("normalizeThreadNoteBody trims and caps independent notes", () => {
  assert.equal(normalizeThreadNoteBody("  remember this  "), "remember this");
  assert.equal(normalizeThreadNoteBody("x".repeat(6000)).length, 5000);
});

test("thread notes are not chat context by default", () => {
  assert.equal(threadNotesAreChatContext(), false);
});
