import "server-only";

import { Pool, type PoolClient, type PoolConfig } from "pg";

/**
 * Server-only Postgres pool.
 *
 * Reads `CONTROL_ROOM_DATABASE_URL` from the process environment. The dev
 * server is expected to source `/etc/hermes/control_room_postgres.env` before
 * `npm run dev` (or run via `dotenv -e ... -- next dev`). If the variable is
 * unset, `getPool()` throws on first use -- callers should wrap calls in
 * `isDbConfigured()` checks or `tryDb(fn)` so a missing DB does not break
 * the app.
 *
 * IMPORTANT: This module must never be imported from a client component.
 * The `import "server-only"` directive above will fail the build if it is.
 */

let pool: Pool | null = null;

function buildPoolConfig(): PoolConfig {
  const url = process.env.CONTROL_ROOM_DATABASE_URL;
  if (!url || !url.trim()) {
    throw new Error(
      "CONTROL_ROOM_DATABASE_URL is not set. " +
        "Source /etc/hermes/control_room_postgres.env before starting the server.",
    );
  }
  // Conservative defaults for a low-traffic internal app.
  return {
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 3_000,
  };
}

export function isDbConfigured(): boolean {
  return Boolean(process.env.CONTROL_ROOM_DATABASE_URL?.trim());
}

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool(buildPoolConfig());
    // Do not let an unexpected pool error crash the process.
    pool.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[db] idle client error:", err.message);
    });
  }
  return pool;
}

/**
 * Run `fn` with a pooled client. Throws if the DB is not configured. Caller
 * is responsible for catching and degrading gracefully.
 */
export async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Run `fn` inside a transaction. Same throwing semantics as `withClient`.
 */
export async function withTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withClient(async (c) => {
    await c.query("BEGIN");
    try {
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  });
}

/**
 * Best-effort DB call. Returns `fallback` if the DB is not configured or any
 * error occurs. Never throws. Intended for read paths where the in-memory
 * fallback should keep the app working when the DB is down.
 */
export async function tryDb<T>(fn: (c: PoolClient) => Promise<T>, fallback: T): Promise<T> {
  if (!isDbConfigured()) return fallback;
  try {
    return await withClient(fn);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[db] call failed, falling back:", err instanceof Error ? err.message : err);
    return fallback;
  }
}
