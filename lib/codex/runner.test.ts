import assert from "node:assert/strict";
import test from "node:test";

import {
  __CODEX_TIMEOUTS__,
  classifyCodexFailure,
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
  // The new error envelope carries a classified `errorKind` and
  // attaches raw stdout/stderr for server-side logging ONLY (the
  // chat route must not forward them to the client).
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(typeof r.errorKind, "string");
    assert.ok(
      ["usage_limit", "auth", "rate_limit", "unsupported", "internal"].includes(r.errorKind),
    );
    // The sanitized `error` is safe to render: no raw stack traces,
    // no Node.js internals, no `at /...` frame lines.
    assert.doesNotMatch(r.error ?? "", /\bnode:[A-Za-z]+:\d+/);
  }
});

test("EXEC timeout is well above status timeout and well below Next.js route budget", () => {
  assert.ok(__CODEX_TIMEOUTS__.VERSION_TIMEOUT_MS <= 5_000);
  assert.ok(__CODEX_TIMEOUTS__.LOGIN_STATUS_TIMEOUT_MS <= 5_000);
  assert.ok(__CODEX_TIMEOUTS__.EXEC_TIMEOUT_MS >= 30_000);
  assert.ok(__CODEX_TIMEOUTS__.EXEC_TIMEOUT_MS <= 150_000);
});

// ---------------------------------------------------------------------------
// classifyCodexFailure: sanitizer for the user-facing error surface.
//
// The brief is explicit that raw Codex CLI stderr must NEVER appear as
// the user-visible assistant message. The runner must detect the well-
// known failure categories and surface a clean UI copy + a kind tag so
// the chat route can render a per-kind final-send failure card.
// ---------------------------------------------------------------------------

test("classifyCodexFailure: usage-limit line → kind=usage_limit, no raw stderr", () => {
  const combined = [
    "warning: Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.",
    "ERROR: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 6:59 PM.",
  ].join("\n");
  const r = classifyCodexFailure(combined);
  assert.equal(r.kind, "usage_limit");
  assert.match(r.userMessage, /usage limit reached/i);
  assert.match(r.userMessage, /not sent with Codex/i);
  // Raw stderr must not leak into the user-facing copy.
  assert.doesNotMatch(r.userMessage, /Skills descriptions/i);
  assert.doesNotMatch(r.userMessage, /chatgpt\.com\/explore\/pro/);
  assert.doesNotMatch(r.userMessage, /bubblewrap/i);
});

test("classifyCodexFailure: skills warning alone (no fatal line) → kind=internal, no warning echoed", () => {
  const r = classifyCodexFailure(
    "warning: Skill descriptions were shortened to fit the 2% skills context budget.\n",
  );
  // The runner falls back to a generic "internal" error when no fatal
  // ERROR: line is present. The skills warning MUST NOT appear.
  assert.equal(r.kind, "internal");
  assert.doesNotMatch(r.userMessage, /Skills descriptions/i);
  assert.doesNotMatch(r.userMessage, /warning/i);
  assert.ok(r.userMessage.length > 0);
});

test("classifyCodexFailure: 401 / not-logged-in → kind=auth", () => {
  const r = classifyCodexFailure("ERROR: 401 Unauthorized: missing bearer token");
  assert.equal(r.kind, "auth");
  assert.match(r.userMessage, /not logged in/i);
});

test("classifyCodexFailure: 429 → kind=rate_limit", () => {
  const r = classifyCodexFailure("ERROR: 429 Too Many Requests");
  assert.equal(r.kind, "rate_limit");
  assert.match(r.userMessage, /rate limit/i);
});

test("classifyCodexFailure: unknown model → kind=unsupported", () => {
  const r = classifyCodexFailure("ERROR: unknown model: gpt-99.99");
  assert.equal(r.kind, "unsupported");
});

test("classifyCodexFailure: strips ANSI colors and clamps to a sane length", () => {
  // Real Codex CLI output contains ANSI color escapes; the sanitizer
  // must strip them and never echo a wall of stderr into the UI.
  const combined =
    "ERROR: \u001b[1m\u001b[31mYou have hit your usage limit. Please upgrade at https://chatgpt.com/codex/settings/usage\u001b[0m";
  const r = classifyCodexFailure(combined);
  assert.equal(r.kind, "usage_limit");
  assert.doesNotMatch(r.userMessage, /\u001b\[/);
});
