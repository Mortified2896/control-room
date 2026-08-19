/**
 * Type-only mirror of `lib/repo/openai-models-discovery.ts`.
 *
 * The repo module is marked `import "server-only"` so it cannot be
 * imported from unit tests that don't have a `server-only` shim. This
 * file re-exports the pure types so unit tests can build snapshots
 * without touching the server-only runtime code.
 *
 * The runtime constant `EMPTY_DISCOVERY_SNAPSHOT` lives here too, with
 * a stable value that matches what `lib/repo/openai-models-discovery.ts`
 * returns. The two are independent at runtime — this file is the test
 * contract, not a shared singleton.
 */

export type DiscoverySource = "openai" | "fake" | "fallback";

export type DiscoverySnapshot = {
  modelIds: ReadonlyArray<string>;
  previousModelIds: ReadonlyArray<string>;
  fetchedAt: Date | null;
  httpStatus: number | null;
  source: DiscoverySource;
  rawCount: number | null;
  errorMessage: string | null;
  updatedAt: Date | null;
};

export const EMPTY_DISCOVERY_SNAPSHOT: DiscoverySnapshot = {
  modelIds: [],
  previousModelIds: [],
  fetchedAt: null,
  httpStatus: null,
  source: "fallback",
  rawCount: 0,
  errorMessage: null,
  updatedAt: null,
};

export const DISCOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
