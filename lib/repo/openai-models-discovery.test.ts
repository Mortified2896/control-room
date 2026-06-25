import assert from "node:assert/strict";
import test from "node:test";

import {
  DISCOVERY_MAX_AGE_MS,
  EMPTY_DISCOVERY_SNAPSHOT,
  __resetDiscoveryForTests,
  getDiscoverySnapshot,
  writeDiscoveryFailure,
  writeDiscoverySuccess,
} from "./openai-models-discovery.ts";
import { isDbConfigured } from "@/lib/db.ts";

/**
 * Integration tests for the discovery cache. They require a live
 * CONTROL_ROOM_DATABASE_URL; if the DB is not configured they are
 * skipped gracefully. We use __resetDiscoveryForTests to keep state
 * clean across runs and clean up after each test.
 */

test.before(async () => {
  if (!isDbConfigured()) return;
  await __resetDiscoveryForTests();
});

test.after(async () => {
  if (!isDbConfigured()) return;
  await __resetDiscoveryForTests();
});

test("getDiscoverySnapshot returns the fallback snapshot when DB is not configured", async () => {
  // This test always runs (does not require DB): it asserts that
  // `tryDb` falls back to the empty snapshot.
  const snapshot = await getDiscoverySnapshot();
  if (!isDbConfigured()) {
    assert.deepEqual(snapshot, EMPTY_DISCOVERY_SNAPSHOT);
  } else {
    assert.ok(snapshot.modelIds !== undefined);
    assert.ok(Array.isArray(snapshot.modelIds));
  }
});

test("writeDiscoverySuccess persists model ids and bumps fetched_at", async (t) => {
  if (!isDbConfigured()) {
    t.skip();
    return;
  }
  await __resetDiscoveryForTests();
  await writeDiscoverySuccess({
    modelIds: ["gpt-5.4-mini", "gpt-5.5"],
    httpStatus: 200,
    source: "fake",
  });
  const snapshot = await getDiscoverySnapshot();
  assert.deepEqual([...snapshot.modelIds].sort(), ["gpt-5.4-mini", "gpt-5.5"]);
  assert.equal(snapshot.source, "fake");
  assert.equal(snapshot.httpStatus, 200);
  assert.ok(snapshot.fetchedAt);
  assert.ok(Date.now() - snapshot.fetchedAt.getTime() < 5_000);
  assert.equal(snapshot.errorMessage, null);
});

test("writeDiscoverySuccess promotes prior model_ids into previous_model_ids", async (t) => {
  if (!isDbConfigured()) {
    t.skip();
    return;
  }
  await __resetDiscoveryForTests();
  await writeDiscoverySuccess({
    modelIds: ["gpt-5.4-mini", "gpt-5.5"],
    httpStatus: 200,
    source: "fake",
  });
  await writeDiscoverySuccess({
    modelIds: ["gpt-5.5"],
    httpStatus: 200,
    source: "fake",
  });
  const snapshot = await getDiscoverySnapshot();
  assert.deepEqual([...snapshot.modelIds].sort(), ["gpt-5.5"]);
  assert.deepEqual([...snapshot.previousModelIds].sort(), ["gpt-5.4-mini", "gpt-5.5"]);
});

test("writeDiscoveryFailure records the error without clearing model_ids", async (t) => {
  if (!isDbConfigured()) {
    t.skip();
    return;
  }
  await __resetDiscoveryForTests();
  await writeDiscoverySuccess({
    modelIds: ["gpt-5.4-mini"],
    httpStatus: 200,
    source: "fake",
  });
  await writeDiscoveryFailure({
    errorMessage: "upstream 503",
    httpStatus: 503,
    source: "openai",
  });
  const snapshot = await getDiscoverySnapshot();
  assert.deepEqual([...snapshot.modelIds].sort(), ["gpt-5.4-mini"]);
  assert.equal(snapshot.errorMessage, "upstream 503");
  assert.equal(snapshot.httpStatus, 503);
  // fetched_at should still point to the prior successful refresh.
  assert.ok(snapshot.fetchedAt);
});

test("DISCOVERY_MAX_AGE_MS is 24h", () => {
  assert.equal(DISCOVERY_MAX_AGE_MS, 24 * 60 * 60 * 1000);
});

test("__resetDiscoveryForTests clears model_ids and error", async (t) => {
  if (!isDbConfigured()) {
    t.skip();
    return;
  }
  await writeDiscoverySuccess({
    modelIds: ["gpt-5.4-mini"],
    httpStatus: 200,
    source: "fake",
  });
  await __resetDiscoveryForTests();
  const snapshot = await getDiscoverySnapshot();
  assert.equal(snapshot.modelIds.length, 0);
  assert.equal(snapshot.source, "fallback");
  assert.equal(snapshot.fetchedAt, null);
  assert.equal(snapshot.errorMessage, null);
});
