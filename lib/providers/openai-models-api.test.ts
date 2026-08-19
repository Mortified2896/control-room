import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeOpenAIErrorDetail } from "./openai-models-api.ts";

test("sanitizeOpenAIErrorDetail redacts API key fragments from OpenAI errors", () => {
  const raw =
    '{ "error": { "message": "Incorrect API key provided: c0803c61********************************0921. You can find your API key at https://platform.openai.com/account/api-keys." } }';
  const sanitized = sanitizeOpenAIErrorDetail(raw);

  assert.match(sanitized, /Incorrect API key provided: \[redacted\]/);
  assert.doesNotMatch(sanitized, /c0803c61/);
  assert.doesNotMatch(sanitized, /0921/);
});

test("sanitizeOpenAIErrorDetail redacts sk-style keys", () => {
  const sanitized = sanitizeOpenAIErrorDetail("bad key sk-proj-abc123_DEF-456");
  assert.equal(sanitized, "bad key sk-[redacted]");
});
