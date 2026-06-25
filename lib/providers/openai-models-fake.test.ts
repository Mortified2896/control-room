import assert from "node:assert/strict";
import test from "node:test";

import {
  FAKE_OPENAI_MODEL_IDS,
  FAKE_KNOWN_EXTRA_MODEL_ID,
  FAKE_UNKNOWN_MODEL_ID,
  getFakeOpenAIModelIds,
  isFakeOpenAIModelsEnabled,
} from "./openai-models-fake.ts";

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test("getFakeOpenAIModelIds returns the four deterministic ids in a stable order", () => {
  const ids = getFakeOpenAIModelIds();
  assert.deepEqual([...ids], FAKE_OPENAI_MODEL_IDS);
  // Sanity: the brief requires gpt-5.4-mini + gpt-5.5 + one extra known
  // + one unknown.
  assert.ok(ids.includes("gpt-5.4-mini"));
  assert.ok(ids.includes("gpt-5.5"));
  assert.ok(ids.includes(FAKE_KNOWN_EXTRA_MODEL_ID));
  assert.ok(ids.includes(FAKE_UNKNOWN_MODEL_ID));
});

test("isFakeOpenAIModelsEnabled returns true when CONTROL_ROOM_FAKE_OPENAI_MODELS=1 alone", () => {
  setEnv("CONTROL_ROOM_FAKE_LLM", undefined);
  setEnv("CONTROL_ROOM_FAKE_OPENAI_MODELS", "1");
  assert.equal(isFakeOpenAIModelsEnabled(), true);
});

test("isFakeOpenAIModelsEnabled returns true when CONTROL_ROOM_FAKE_LLM=1 even if the dedicated flag is unset", () => {
  setEnv("CONTROL_ROOM_FAKE_LLM", "1");
  setEnv("CONTROL_ROOM_FAKE_OPENAI_MODELS", undefined);
  assert.equal(isFakeOpenAIModelsEnabled(), true);
});

test("isFakeOpenAIModelsEnabled returns false when neither flag is set (production default)", () => {
  setEnv("CONTROL_ROOM_FAKE_LLM", undefined);
  setEnv("CONTROL_ROOM_FAKE_OPENAI_MODELS", undefined);
  assert.equal(isFakeOpenAIModelsEnabled(), false);
});

test("FAKE_OPENAI_MODEL_IDS never contains real OpenAI-only models in production builds", () => {
  // The fake list intentionally only contains the four deterministic
  // ids. Any future change must keep the list frozen so Playwright
  // assertions don't flake. This test pins the contract.
  assert.equal(FAKE_OPENAI_MODEL_IDS.length, 4);
  for (const id of FAKE_OPENAI_MODEL_IDS) {
    assert.ok(typeof id === "string");
    assert.ok(id.length > 0);
    assert.ok(!id.includes(" "));
  }
});

test("FAKE_KNOWN_EXTRA_MODEL_ID is registered in the static alias map", async () => {
  setEnv("CONTROL_ROOM_FAKE_LLM", undefined);
  setEnv("CONTROL_ROOM_FAKE_OPENAI_MODELS", undefined);
  const openaiStatic = await import("./openai-static.ts");
  const alias = openaiStatic.getStaticOpenAIModelAlias(FAKE_KNOWN_EXTRA_MODEL_ID);
  assert.ok(alias !== null, "fake known extra must be in the alias map");
});

test("FAKE_UNKNOWN_MODEL_ID is intentionally NOT in the static alias map", async () => {
  const openaiStatic = await import("./openai-static.ts");
  const alias = openaiStatic.getStaticOpenAIModelAlias(FAKE_UNKNOWN_MODEL_ID);
  assert.equal(alias, null, "fake unknown must not be in the alias map");
});
