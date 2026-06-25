import assert from "node:assert/strict";
import test from "node:test";

import { buildEffectiveRegistry } from "./registry.ts";
import {
  EMPTY_DISCOVERY_SNAPSHOT,
  type DiscoverySnapshot,
} from "@/lib/repo/openai-models-discovery-types.ts";
import type { SelectorPreferences } from "@/lib/repo/model-selector-prefs-types.ts";

function snapshot(
  modelIds: ReadonlyArray<string>,
  fetchedAt: Date | null = null,
  previousModelIds: ReadonlyArray<string> = [],
): DiscoverySnapshot {
  return {
    modelIds,
    previousModelIds,
    fetchedAt,
    httpStatus: 200,
    source: modelIds.length > 0 ? "openai" : "fallback",
    rawCount: modelIds.length,
    errorMessage: null,
    updatedAt: fetchedAt,
  };
}

// Production alias fixture (no fake ids). Mirrors `lib/providers/openai-static.ts`
// in production mode.
const PROD_ALIASES = new Map<
  string,
  {
    label: string;
    tier: "cheap" | "expensive";
    reasoningLevels: ReadonlyArray<"low" | "medium" | "high">;
  }
>([
  ["gpt-5.4-mini", { label: "GPT-5.4 Mini", tier: "cheap", reasoningLevels: ["low", "medium"] }],
  ["gpt-5.5", { label: "GPT-5.5", tier: "expensive", reasoningLevels: ["low", "medium", "high"] }],
]);
// Fake-mode alias fixture: adds `gpt-fake-known-extra` as a known alias
// (cheap tier, low/medium reasoning). `gpt-fake-unknown-xyz` is intentionally
// absent so the merge layer treats it as unknown.
const FAKE_ALIASES = new Map(PROD_ALIASES);
FAKE_ALIASES.set("gpt-fake-known-extra", {
  label: "GPT-Fake Known Extra",
  tier: "cheap",
  reasoningLevels: ["low", "medium"],
});

const NO_PREFS: SelectorPreferences = Object.freeze({});

function makeOverrides(includeFake: boolean) {
  const map = includeFake ? FAKE_ALIASES : PROD_ALIASES;
  return {
    staticAliasResolver: (id: string) => map.get(id) ?? null,
    isKnownOverride: (id: string) => map.has(id),
    listKnownAliasesOverride: () =>
      [...map.entries()] as Array<
        readonly [
          string,
          {
            label: string;
            tier: "cheap" | "expensive";
            reasoningLevels: ReadonlyArray<"low" | "medium" | "high">;
          },
        ]
      >,
  };
}

test("buildEffectiveRegistry returns the static catalog when discovery is empty", () => {
  const registry = buildEffectiveRegistry({
    discovery: EMPTY_DISCOVERY_SNAPSHOT,
    selectorPrefs: NO_PREFS,
    openaiKeySet: true,
    fakeMode: false,
    ...makeOverrides(false),
  });
  assert.equal(registry.models.length, PROD_ALIASES.size);
  for (const entry of registry.models) {
    assert.equal(entry.configured, true);
    assert.equal(entry.available, false);
    assert.equal(entry.stale, false);
    assert.equal(entry.usableForChat, false);
    assert.equal(entry.manualSelectorVisible, false);
    assert.equal(entry.routerEligible, false);
  }
});

test("buildEffectiveRegistry marks configured discovered models as available + usable", () => {
  const registry = buildEffectiveRegistry({
    discovery: snapshot(["gpt-5.4-mini", "gpt-5.5"]),
    selectorPrefs: NO_PREFS,
    openaiKeySet: true,
    fakeMode: false,
    ...makeOverrides(false),
  });
  const byId = new Map(registry.models.map((m) => [m.modelId, m] as const));
  const mini = byId.get("gpt-5.4-mini");
  assert.ok(mini);
  assert.equal(mini.configured, true);
  assert.equal(mini.available, true);
  assert.equal(mini.stale, false);
  assert.equal(mini.usableForChat, true);
  assert.equal(mini.manualSelectorVisible, true);
  assert.equal(mini.routerEligible, true);
  const big = byId.get("gpt-5.5");
  assert.ok(big);
  assert.equal(big.configured, true);
  assert.equal(big.available, true);
  assert.equal(big.manualSelectorVisible, true);
  assert.equal(big.routerEligible, true);
});

test("buildEffectiveRegistry marks unclassified discovered models as hidden + not router-eligible by default", () => {
  const registry = buildEffectiveRegistry({
    discovery: snapshot(["gpt-5.4-mini", "gpt-not-a-real-model"]),
    selectorPrefs: NO_PREFS,
    openaiKeySet: true,
    fakeMode: false,
    ...makeOverrides(false),
  });
  const unclassified = registry.models.find((m) => m.modelId === "gpt-not-a-real-model");
  assert.ok(unclassified);
  assert.equal(unclassified.configured, false);
  assert.equal(unclassified.available, true);
  assert.equal(unclassified.usableForChat, false);
  assert.equal(unclassified.manualSelectorVisible, false);
  assert.equal(unclassified.routerEligible, false);
  assert.equal(unclassified.provenance, "discovered_only");
});

test("buildEffectiveRegistry marks a model as stale when it disappears from a fresh discovery", () => {
  const registry = buildEffectiveRegistry({
    discovery: snapshot(["gpt-5.5"], null, ["gpt-5.4-mini", "gpt-5.5"]),
    selectorPrefs: NO_PREFS,
    openaiKeySet: true,
    fakeMode: false,
    ...makeOverrides(false),
  });
  const mini = registry.models.find((m) => m.modelId === "gpt-5.4-mini");
  assert.ok(mini);
  assert.equal(mini.configured, true);
  assert.equal(mini.available, false);
  assert.equal(mini.stale, true);
  assert.equal(mini.manualSelectorVisible, false);
  assert.equal(mini.routerEligible, false);
  assert.equal(mini.provenance, "stale");
});

test("buildEffectiveRegistry defaults manualModelId to first cheap-tier configured visible entry", () => {
  const registry = buildEffectiveRegistry({
    discovery: snapshot(["gpt-5.4-mini", "gpt-5.5"]),
    selectorPrefs: NO_PREFS,
    openaiKeySet: true,
    fakeMode: false,
    ...makeOverrides(false),
  });
  assert.equal(registry.defaults.manualModelId, "gpt-5.4-mini");
});

test("buildEffectiveRegistry honors explicit opt-in for an unclassified model", () => {
  // The brief asks for a less-restrictive manual selector: users should
  // be able to opt-in to an unconfigured OpenAI model so they can
  // experiment with it from the chat composer.
  const registry = buildEffectiveRegistry({
    discovery: snapshot(["gpt-not-a-real-model"]),
    selectorPrefs: Object.freeze({ "gpt-not-a-real-model": { visible: true } }),
    openaiKeySet: true,
    fakeMode: false,
    ...makeOverrides(false),
  });
  const unclassified = registry.models.find((m) => m.modelId === "gpt-not-a-real-model");
  assert.ok(unclassified);
  // The user's explicit opt-in shows the model in the selector even
  // though it has no local metadata.
  assert.equal(unclassified.manualSelectorVisible, true);
  assert.equal(unclassified.manuallyOverridden, true);
  // Crucially: still not usable for chat (no metadata + no reasoning
  // support) and still NOT router-eligible. Opt-in is for the manual
  // picker only.
  assert.equal(unclassified.usableForChat, false);
  assert.equal(unclassified.routerEligible, false);
});

test("buildEffectiveRegistry honors explicit opt-out for a configured model", () => {
  const registry = buildEffectiveRegistry({
    discovery: snapshot(["gpt-5.4-mini"]),
    selectorPrefs: Object.freeze({ "gpt-5.4-mini": { visible: false } }),
    openaiKeySet: true,
    fakeMode: false,
    ...makeOverrides(false),
  });
  const mini = registry.models.find((m) => m.modelId === "gpt-5.4-mini");
  assert.ok(mini);
  assert.equal(mini.manualSelectorVisible, false);
  assert.equal(mini.manuallyOverridden, true);
  // Still router-eligible — opting out of the manual selector does not
  // affect the router pool.
  assert.equal(mini.routerEligible, true);
});

test("buildEffectiveRegistry marks usableForChat=false when openaiKeySet is false", () => {
  const registry = buildEffectiveRegistry({
    discovery: snapshot(["gpt-5.4-mini"]),
    selectorPrefs: NO_PREFS,
    openaiKeySet: false,
    fakeMode: false,
    ...makeOverrides(false),
  });
  const mini = registry.models.find((m) => m.modelId === "gpt-5.4-mini");
  assert.ok(mini);
  assert.equal(mini.usableForChat, false);
  // Without the API key, the model is NOT visible by default — the
  // user has to opt-in explicitly to see it (which they can do for
  // experimentation; the chat will refuse the call at runtime).
  assert.equal(mini.manualSelectorVisible, false);
  assert.equal(mini.routerEligible, true);
});

test("buildEffectiveRegistry renders the fake model ids when fakeMode is on", () => {
  const registry = buildEffectiveRegistry({
    discovery: snapshot([
      "gpt-5.4-mini",
      "gpt-5.5",
      "gpt-fake-known-extra",
      "gpt-fake-unknown-xyz",
    ]),
    selectorPrefs: NO_PREFS,
    openaiKeySet: true,
    fakeMode: true,
    ...makeOverrides(true),
  });
  const fakeKnown = registry.models.find((m) => m.modelId === "gpt-fake-known-extra");
  const fakeUnknown = registry.models.find((m) => m.modelId === "gpt-fake-unknown-xyz");
  assert.ok(fakeKnown);
  assert.ok(fakeUnknown);
  assert.equal(fakeKnown.configured, true);
  assert.equal(fakeKnown.available, true);
  assert.equal(fakeKnown.routerEligible, true);
  assert.equal(fakeKnown.provenance, "fake");
  assert.equal(fakeUnknown.configured, false);
  assert.equal(fakeUnknown.available, true);
  assert.equal(fakeUnknown.routerEligible, false);
  assert.equal(fakeUnknown.provenance, "fake");
});

test("buildEffectiveRegistry never adds fake ids when fakeMode is off (production default)", () => {
  const registry = buildEffectiveRegistry({
    discovery: snapshot([]),
    selectorPrefs: NO_PREFS,
    openaiKeySet: true,
    fakeMode: false,
    ...makeOverrides(false),
  });
  for (const entry of registry.models) {
    assert.notEqual(entry.modelId, "gpt-fake-known-extra");
    assert.notEqual(entry.modelId, "gpt-fake-unknown-xyz");
    assert.notEqual(entry.provenance, "fake");
  }
});

test("buildEffectiveRegistry is deterministic across calls with identical inputs", () => {
  const discovery = snapshot(["gpt-5.4-mini", "gpt-5.5"]);
  const a = buildEffectiveRegistry({
    discovery,
    selectorPrefs: NO_PREFS,
    openaiKeySet: true,
    fakeMode: false,
    ...makeOverrides(false),
  });
  const b = buildEffectiveRegistry({
    discovery,
    selectorPrefs: NO_PREFS,
    openaiKeySet: true,
    fakeMode: false,
    ...makeOverrides(false),
  });
  assert.deepEqual(a.models, b.models);
  assert.deepEqual(a.counts, b.counts);
});

test("buildEffectiveRegistry counts reflect configured/unclassified/stale state", () => {
  const registry = buildEffectiveRegistry({
    discovery: snapshot(["gpt-5.5", "gpt-not-a-real-model"], null, ["gpt-5.4-mini", "gpt-5.5"]),
    selectorPrefs: NO_PREFS,
    openaiKeySet: true,
    fakeMode: false,
    ...makeOverrides(false),
  });
  assert.equal(registry.counts.discovered, 2);
  assert.equal(registry.counts.discoveredConfigured, 1); // gpt-5.5
  assert.equal(registry.counts.discoveredUnclassified, 1); // gpt-not-a-real-model
  assert.equal(registry.counts.configuredAvailable, 1); // gpt-5.5
  assert.equal(registry.counts.stale, 1); // gpt-5.4-mini
  assert.equal(registry.counts.routerEligible, 1); // only gpt-5.5
});

test("buildEffectiveRegistry renders entries in a stable order: configured-first, then alphabetical", () => {
  const registry = buildEffectiveRegistry({
    discovery: snapshot(["gpt-5.4-mini", "gpt-5.5", "gpt-not-a-real-model"]),
    selectorPrefs: NO_PREFS,
    openaiKeySet: true,
    fakeMode: false,
    ...makeOverrides(false),
  });
  const ids = registry.models.map((m) => m.modelId);
  const idx = (id: string) => ids.indexOf(id);
  assert.ok(idx("gpt-5.4-mini") < idx("gpt-5.5"), "cheap tier should render before expensive");
  assert.ok(
    idx("gpt-5.5") < idx("gpt-not-a-real-model"),
    "configured entries should render before unclassified",
  );
});

test("buildEffectiveRegistry capabilities include reasoning for configured models with reasoning levels", () => {
  const registry = buildEffectiveRegistry({
    discovery: snapshot(["gpt-5.4-mini", "gpt-not-a-real-model"]),
    selectorPrefs: NO_PREFS,
    openaiKeySet: true,
    fakeMode: false,
    ...makeOverrides(false),
  });
  const mini = registry.models.find((m) => m.modelId === "gpt-5.4-mini");
  const unclassified = registry.models.find((m) => m.modelId === "gpt-not-a-real-model");
  assert.ok(mini);
  assert.ok(unclassified);
  assert.equal(mini.capabilities.reasoning, true);
  assert.equal(mini.capabilities.streaming, true);
  // Future capability placeholders are always false until the
  // capability registry ships.
  assert.equal(mini.capabilities.vision, false);
  assert.equal(mini.capabilities.images, false);
  assert.equal(mini.capabilities.functionCalling, false);
  assert.equal(mini.capabilities.structuredOutput, false);
  // Unconfigured models get the conservative default reasoning set
  // (["low"]) so the UI can render a single reasoning checkbox; the
  // capability flags surface "unknown" via `configured: false` rather
  // than via capabilities.
  assert.equal(unclassified.capabilities.reasoning, true);
  assert.equal(unclassified.capabilities.streaming, true);
});
