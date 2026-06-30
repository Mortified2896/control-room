import assert from "node:assert/strict";
import test from "node:test";

import { parseCodexCommand, resolveProjectCwd } from "./project-runner.ts";

test("Codex project cwd resolution requires a stored project id, not a client cwd", async () => {
  const resolved = await resolveProjectCwd(null);
  assert.deepEqual(resolved, {
    ok: false,
    code: "no_project",
    error: "No project is selected. Select a project before running Codex CLI.",
  });
});

test("Codex command config is argv-only and never a shell string", () => {
  const previous = process.env.CODEX_CLI_COMMAND;
  process.env.CODEX_CLI_COMMAND = "/tmp/mock-codex exec --safe";
  try {
    assert.deepEqual(parseCodexCommand(), ["/tmp/mock-codex", "exec", "--safe"]);
  } finally {
    if (previous === undefined) delete process.env.CODEX_CLI_COMMAND;
    else process.env.CODEX_CLI_COMMAND = previous;
  }
});
