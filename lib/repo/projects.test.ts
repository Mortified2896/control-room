import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isDbConfigured } from "../db.ts";
import { openProject, validateProjectPath } from "./projects.ts";

const CONTROL_ROOM_PATH = "/home/hermes/workspace/repos/control-room";

test("validateProjectPath accepts a repo under the workspace", async () => {
  const result = await validateProjectPath(CONTROL_ROOM_PATH);
  assert.equal(result.ok, true);
});

test("validateProjectPath rejects paths outside the workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "control-room-project-"));
  const result = await validateProjectPath(dir);
  assert.deepEqual(result, { ok: false, reason: "outside_workspace" });
});

test("validateProjectPath rejects files", async () => {
  const file = join(CONTROL_ROOM_PATH, ".project-validation-file");
  await writeFile(file, "temporary validation fixture");
  try {
    const result = await validateProjectPath(file);
    assert.deepEqual(result, { ok: false, reason: "not_directory" });
  } finally {
    await rm(file, { force: true });
  }
});

test("openProject upserts by local_path", { skip: !isDbConfigured() }, async () => {
  const first = await openProject(CONTROL_ROOM_PATH);
  const second = await openProject(CONTROL_ROOM_PATH);
  assert.equal(second.id, first.id);
  assert.equal(second.localPath, CONTROL_ROOM_PATH);
  assert.equal(second.name, "control-room");
  assert.ok(second.lastOpenedAt);
});
