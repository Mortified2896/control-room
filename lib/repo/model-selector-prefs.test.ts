import assert from "node:assert/strict";
import test from "node:test";

import {
  __resetSelectorPrefsForTests,
  getSelectorPreferences,
  setSelectorPreferences,
} from "./model-selector-prefs.ts";
import { isDbConfigured } from "@/lib/db.ts";

test.before(async () => {
  if (!isDbConfigured()) return;
  await __resetSelectorPrefsForTests();
});

test.after(async () => {
  if (!isDbConfigured()) return;
  await __resetSelectorPrefsForTests();
});

test("getSelectorPreferences returns the empty object when DB is not configured", async () => {
  const prefs = await getSelectorPreferences();
  if (!isDbConfigured()) {
    assert.deepEqual(prefs, {});
  } else {
    assert.ok(prefs !== undefined);
  }
});

test("setSelectorPreferences validates and writes valid payloads", async (t) => {
  if (!isDbConfigured()) {
    t.skip();
    return;
  }
  await __resetSelectorPrefsForTests();
  const result = await setSelectorPreferences({
    preferences: {
      "gpt-5.4-mini": { visible: true },
      "gpt-5.5": { visible: false },
    },
    updatedBy: "test",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value["gpt-5.4-mini"]?.visible, true);
    assert.equal(result.value["gpt-5.5"]?.visible, false);
  }
  const reloaded = await getSelectorPreferences();
  assert.equal(reloaded["gpt-5.4-mini"]?.visible, true);
  assert.equal(reloaded["gpt-5.5"]?.visible, false);
});

test("setSelectorPreferences rejects non-object payloads", async (t) => {
  if (!isDbConfigured()) {
    t.skip();
    return;
  }
  const result = await setSelectorPreferences({
    preferences: "not-an-object" as unknown as Record<string, unknown>,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((e) => e.field === "preferences"));
  }
});

test("setSelectorPreferences rejects non-boolean visible", async (t) => {
  if (!isDbConfigured()) {
    t.skip();
    return;
  }
  const result = await setSelectorPreferences({
    preferences: {
      "gpt-5.4-mini": { visible: "yes" as unknown as boolean },
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((e) => e.field.startsWith("preferences.")));
  }
});

test("setSelectorPreferences rejects empty model ids", async (t) => {
  if (!isDbConfigured()) {
    t.skip();
    return;
  }
  const result = await setSelectorPreferences({
    preferences: {
      "": { visible: true },
    },
  });
  assert.equal(result.ok, false);
});

test("__resetSelectorPrefsForTests clears all preferences", async (t) => {
  if (!isDbConfigured()) {
    t.skip();
    return;
  }
  await setSelectorPreferences({
    preferences: { "gpt-5.4-mini": { visible: false } },
  });
  await __resetSelectorPrefsForTests();
  const prefs = await getSelectorPreferences();
  assert.equal(Object.keys(prefs).length, 0);
});
