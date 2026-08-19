import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyMiniMaxFailure,
  extractJsonErrorMessage,
} from "./runner";

test("classifyMiniMaxFailure flags usage_limit", () => {
  const result = classifyMiniMaxFailure("token plan exhausted. Try again later.");
  assert.equal(result.kind, "usage_limit");
  assert.match(result.userMessage, /token plan exhausted/i);
});

test("classifyMiniMaxFailure flags auth on 401", () => {
  const result = classifyMiniMaxFailure('{"error":{"code":1,"message":"API error: HTTP 401 (HTTP 401)"}}');
  assert.equal(result.kind, "auth");
  assert.match(result.userMessage, /MiniMax API rejected/);
});

test("classifyMiniMaxFailure flags unsupported on 404", () => {
  const result = classifyMiniMaxFailure('{"error":{"code":1,"message":"API error: HTTP 404 (HTTP 404)"}}');
  assert.equal(result.kind, "unsupported");
  assert.match(result.userMessage, /does not support this model/i);
});

test("classifyMiniMaxFailure flags rate_limit on 429", () => {
  const result = classifyMiniMaxFailure('{"error":{"code":1,"message":"API error: HTTP 429 too many requests"}}');
  assert.equal(result.kind, "rate_limit");
});

test("classifyMiniMaxFailure falls back to internal + sanitized tail", () => {
  const result = classifyMiniMaxFailure("some random internal error\nERROR: weird thing happened");
  assert.equal(result.kind, "internal");
  assert.match(result.userMessage, /weird thing happened/);
});

test("extractJsonErrorMessage parses single JSON document", () => {
  const text = '{"error":{"code":1,"message":"HTTP 500"}}';
  assert.equal(extractJsonErrorMessage(text), "HTTP 500");
});

test("extractJsonErrorMessage parses pretty-printed JSON object", () => {
  const text = '{\n  "error": {\n    "code": 1,\n    "message": "HTTP 404"\n  }\n}';
  assert.equal(extractJsonErrorMessage(text), "HTTP 404");
});

test("extractJsonErrorMessage returns null on plain text", () => {
  assert.equal(extractJsonErrorMessage("just a plain message"), null);
});
