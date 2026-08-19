import test from "node:test";
import assert from "node:assert/strict";

import { refreshCodexModels } from "./codex-discovery";

test("Codex refresh returns static catalog without API discovery", async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const outcome = await refreshCodexModels();
    assert.equal(outcome.kind, "fresh");
    assert.equal(outcome.source, "codex_catalog");
    assert.equal(outcome.discoveryType, "static_catalog");
    assert.equal(outcome.requiresApiKey, false);
    assert.deepEqual(outcome.modelIds, [
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
    assert.equal(outcome.modelIds.includes("gpt-5.5-small"), false);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});
