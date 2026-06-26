import assert from "node:assert/strict";
import test from "node:test";

import {
  __CODEX_TIMEOUTS__,
  classifyLoginStatusResult,
  resolveCodexBinary,
  resolveScratchDir,
  runCodexCommand,
  runCodexExec,
} from "./runner.ts";
import { probeCodexStatus } from "./status.ts";

test("resolveCodexBinary returns a string or null", () => {
  const p = resolveCodexBinary();
  assert.ok(p === null || typeof p === "string");
});

test("resolveScratchDir creates the dir if missing and is hermes-writable", () => {
  const d = resolveScratchDir();
  assert.ok(d.length > 0);
  assert.match(d, /\/control-room-codex-smoke$/);
});

test('non-zero command with stdout "Not logged in" classifies as not_logged_in', () => {
  const status = classifyLoginStatusResult({
    exitCode: 1,
    stdout: "Not logged in\n",
    stderr: "",
    timedOut: false,
  });
  assert.equal(status, "not_logged_in");
});

test("timed-out login status classifies as unknown", () => {
  const status = classifyLoginStatusResult({
    exitCode: null,
    stdout: "",
    stderr: "",
    timedOut: true,
  });
  assert.equal(status, "unknown");
});

test("runCodexCommand captures stdout/stderr on non-zero exit", async () => {
  const r = await runCodexCommand(
    process.execPath,
    ["-e", "process.stdout.write('Not logged in'); process.exit(1)"],
    { timeoutMs: 5_000 },
  );
  assert.equal(r.exitCode, 1);
  assert.equal(r.stdout, "Not logged in");
  assert.equal(r.stderr, "");
  assert.equal(r.timedOut, false);
});

test("runCodexCommand marks timeout without hanging", async () => {
  const started = Date.now();
  const r = await runCodexCommand(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
    timeoutMs: 100,
  });
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null);
  assert.ok(Date.now() - started < 5_000);
});

test("probeCodexStatus returns a structured installed status on current server", async () => {
  const status = await probeCodexStatus();
  assert.ok(["not_logged_in", "logged_in", "error"].includes(status.status));
  assert.equal(status.binary.path, "/home/hermes/.hermes/node/bin/codex");
  assert.equal(status.binary.version, "0.142.2");
  assert.equal(status.binary.resolvedFrom, "PATH");
  assert.equal(status.auth.accountHint, null);
  assert.doesNotMatch(JSON.stringify(status), /sk-[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(JSON.stringify(status), /eyJ[A-Za-z0-9_-]{10,}\./);
});

test("runCodexExec rejects empty / oversized prompts without spawning a process", async () => {
  const binary = resolveCodexBinary() ?? process.execPath;
  const empty = await runCodexExec(binary, "   ");
  assert.equal(empty.ok, false);
  assert.equal(empty.responseText, null);
  assert.match(empty.error ?? "", /empty/);

  const huge = await runCodexExec(binary, "x".repeat(5000));
  assert.equal(huge.ok, false);
  assert.match(huge.error ?? "", /4000/);
});

test("chat helper returns sanitized errors when exec result fails", async () => {
  const r = await runCodexExec(process.execPath, "Reply with only: pong");
  assert.equal(r.ok, false);
  assert.equal(r.responseText, null);
  assert.ok(r.error);
  assert.doesNotMatch(r.error ?? "", /sk-[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(r.error ?? "", /eyJ[A-Za-z0-9_-]{10,}\./);
});

test("EXEC timeout is well above status timeout and well below Next.js route budget", () => {
  assert.ok(__CODEX_TIMEOUTS__.VERSION_TIMEOUT_MS <= 5_000);
  assert.ok(__CODEX_TIMEOUTS__.LOGIN_STATUS_TIMEOUT_MS <= 5_000);
  assert.ok(__CODEX_TIMEOUTS__.EXEC_TIMEOUT_MS >= 30_000);
  assert.ok(__CODEX_TIMEOUTS__.EXEC_TIMEOUT_MS <= 150_000);
});
