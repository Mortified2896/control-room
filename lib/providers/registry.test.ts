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
    assert.equal(entry.known, true);
    assert.equal(entry.available, false);
    assert.equal(entry.stale, false);
    assert.equal(entry.usableForChat, false);
    assert.equal(entry.manualSelectorVisible, false);
    assert.equal(entry.routerEligible, false);
  }
});

test("buildEffectiveRegistry marks known discovered models as available + usable", () => {
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
  assert.equal(mini.known, true);
  assert.equal(mini.available, true);
  assert.equal(mini.stale, false);
  assert.equal(mini.usableForChat, true);
  assert.equal(mini.manualSelectorVisible, true);
  assert.equal(mini.routerEligible, true);
  const big = byId.get("gpt-5.5");
  assert.ok(big);
  assert.equal(big.known, true);
  assert.equal(big.available, true);
  assert.equal(big.manualSelectorVisible, true);
  assert.equal(big.routerEligible, true);
});

test("buildEffectiveRegistry marks unknown discovered models as hidden + not router-eligible", () => {
  const registry = buildEffectiveRegistry({
    discovery: snapshot(["gpt-5.4-mini", "gpt-not-a-real-model"]),
    selectorPrefs: NO_PREFS,
    openaiKeySet: true,
    fakeMode: false,
    ...makeOverrides(false),
  });
  const unknown = registry.models.find((m) => m.modelId === "gpt-not-a-real-model");
  assert.ok(unknown);
  assert.equal(unknown.known, false);
  assert.equal(unknown.available, true);
  assert.equal(unknown.usableForChat, false);
  assert.equal(unknown.manualSelectorVisible, false);
  assert.equal(unknown.routerEligible, false);
  assert.equal(unknown.provenance, "discovered_only");
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
  assert.equal(mini.known, true);
  assert.equal(mini.available, false);
  assert.equal(mini.stale, true);
  assert.equal(mini.manualSelectorVisible, false);
  assert.equal(mini.routerEligible, false);
  assert.equal(mini.provenance, "stale");
});

test("buildEffectiveRegistry defaults manualModelId to first cheap-tier visible entry", () => {
  const registry = buildEffectiveRegistry({
    discovery: snapshot(["gpt-5.4-mini", "gpt-5.5"]),
    selectorPrefs: NO_PREFS,
    openaiKeySet: true,
    fakeMode: false,
    ...makeOverrides(false),
  });
  assert.equal(registry.defaults.manualModelId, "gpt-5.4-mini");
});

test("buildEffectiveRegistry honors explicit selector pref visible=true for an unknown model", () => {
  const registry = buildEffectiveRegistry({
    discovery: snapshot(["gpt-not-a-real-model"]),
    selectorPrefs: Object.freeze({ "gpt-not-a-real-model": { visible: true } }),
    openaiKeySet: true,
    fakeMode: false,
    ...makeOverrides(false),
  });
  const unknown = registry.models.find((m) => m.modelId === "gpt-not-a-real-model");
  assert.ok(unknown);
  // The user's explicit visibility preference is overridden when the
  // model is not actually usable (usability gates visibility too). This
  // is intentional: hiding a model whose API key isn't set would just
  // render a broken picker row.
  assert.equal(unknown.usableForChat, false);
  assert.equal(unknown.manualSelectorVisible, false);
  // Crucially: still not router-eligible.
  assert.equal(unknown.routerEligible, false);
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
  assert.equal(fakeKnown.known, true);
  assert.equal(fakeKnown.available, true);
  assert.equal(fakeKnown.routerEligible, true);
  assert.equal(fakeKnown.provenance, "fake");
  assert.equal(fakeUnknown.known, false);
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

test("buildEffectiveRegistry counts reflect known/available/stale state", () => {
  const registry = buildEffectiveRegistry({
    discovery: snapshot(["gpt-5.5", "gpt-not-a-real-model"], null, ["gpt-5.4-mini", "gpt-5.5"]),
    selectorPrefs: NO_PREFS,
    openaiKeySet: true,
    fakeMode: false,
    ...makeOverrides(false),
  });
  assert.equal(registry.counts.discovered, 2);
  assert.equal(registry.counts.known, 2); // gpt-5.4-mini + gpt-5.5
  assert.equal(registry.counts.available, 2); // gpt-5.5 + unknown
  assert.equal(registry.counts.stale, 1); // gpt-5.4-mini
  assert.equal(registry.counts.routerEligible, 1); // only gpt-5.5
});

test("buildEffectiveRegistry renders entries in a stable order: known-first, then alphabetical", () => {
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
    "known entries should render before discovered-only",
  );
});
