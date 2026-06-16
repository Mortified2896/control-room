#!/usr/bin/env node
/**
 * Control Room — migration runner.
 *
 * Usage:
 *   CONTROL_ROOM_DATABASE_URL=postgres://... node scripts/migrate.mjs
 *
 * Or, when the env file is readable by the current user:
 *   set -a; . /etc/hermes/control_room_postgres.env; set +a
 *   node scripts/migrate.mjs
 *
 * What it does:
 *   1. Connects to the DB referenced by CONTROL_ROOM_DATABASE_URL.
 *   2. Ensures a `schema_migrations` bookkeeping table exists.
 *   3. Lists *.sql files in db/migrations/ (lexical order), applies any whose
 *      filename is not already recorded, and records them in the same
 *      transaction as the schema change.
 *   4. Prints a one-line summary per migration. Never prints the DSN.
 *
 * Exit codes:
 *   0  success (no-op or applied)
 *   1  any failure
 */

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const migrationsDir = join(repoRoot, "db", "migrations");

function log(...args) {
  // eslint-disable-next-line no-console
  console.log("[migrate]", ...args);
}

function die(msg, err) {
  // eslint-disable-next-line no-console
  console.error("[migrate] ERROR:", msg);
  if (err) {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.stack || err.message : err);
  }
  process.exit(1);
}

async function main() {
  const url = process.env.CONTROL_ROOM_DATABASE_URL;
  if (!url || !url.trim()) {
    die(
      "CONTROL_ROOM_DATABASE_URL is not set. Source /etc/hermes/control_room_postgres.env first.",
    );
  }

  let files;
  try {
    files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  } catch (err) {
    die(`Could not read migrations dir ${migrationsDir}`, err);
  }

  if (files.length === 0) {
    log("no migration files in db/migrations/ — nothing to do");
    return;
  }

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
  } catch (err) {
    die(
      "Could not connect to Postgres (check CONTROL_ROOM_DATABASE_URL and that the DB/role exist)",
      err,
    );
  }

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const appliedResult = await client.query("SELECT filename FROM schema_migrations");
    const applied = new Set(appliedResult.rows.map((r) => r.filename));

    for (const file of files) {
      if (applied.has(file)) {
        log(`skip   ${file} (already applied)`);
        continue;
      }
      const sql = await readFile(join(migrationsDir, file), "utf8");
      log(`apply  ${file}`);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
        log(`ok     ${file}`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        die(`Migration ${file} failed; rolled back`, err);
      }
    }

    log("done");
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((err) => die("Unhandled error", err));
