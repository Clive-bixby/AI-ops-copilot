import "../config/env.js";

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pool } from "../core/db.js";

// Resolved from this file so the script works from any working directory and
// inside the container, where the app lives at /app.
const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations"
);

// Arbitrary constant; only used to serialise concurrent migration runs.
const ADVISORY_LOCK_ID = 914_570_221;

const LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

export type MigrationResult = {
  /** Migrations actually executed in this run. */
  applied: number;
  /** Migrations recorded without executing them (baseline mode). */
  recorded: number;
  /** Migrations that were already applied with a matching checksum. */
  skipped: number;
};

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function readMigrations(): { filename: string; sql: string }[] {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }

  const filenames = fs
    .readdirSync(migrationsDir)
    .filter((filename) => filename.endsWith(".sql"))
    .sort();

  if (filenames.length === 0) {
    throw new Error(`No .sql migrations found in ${migrationsDir}`);
  }

  return filenames.map((filename) => ({
    filename,
    sql: fs.readFileSync(path.join(migrationsDir, filename), "utf8"),
  }));
}

/**
 * Apply every pending migration in filename order.
 *
 * Exported so integration tests migrate the test database through exactly the
 * same code path as a deployment; a test-only migration runner would be able to
 * drift from the real one. The pool is left open because the caller owns it.
 */
export async function runMigrations(
  options: { baseline?: boolean; quiet?: boolean } = {}
): Promise<MigrationResult> {
  const baseline = options.baseline === true;
  const log = options.quiet === true ? () => undefined : console.log;
  const migrations = readMigrations();
  const client = await pool.connect();
  const result: MigrationResult = { applied: 0, recorded: 0, skipped: 0 };

  try {
    await client.query(LEDGER_SQL);
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_ID]);

    const ledger = await client.query<{ filename: string; checksum: string }>(
      "SELECT filename, checksum FROM schema_migrations"
    );
    const applied = new Map(
      ledger.rows.map((row) => [row.filename, row.checksum])
    );

    for (const migration of migrations) {
      const digest = checksum(migration.sql);
      const previousChecksum = applied.get(migration.filename);

      if (previousChecksum !== undefined) {
        if (previousChecksum !== digest) {
          throw new Error(
            `Migration ${migration.filename} changed after it was applied. ` +
              "Add a new migration instead of editing an applied one."
          );
        }

        result.skipped += 1;
        log(`skip    ${migration.filename} (already applied)`);
        continue;
      }

      if (baseline) {
        await client.query(
          "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
          [migration.filename, digest]
        );
        result.recorded += 1;
        log(`record  ${migration.filename} (baseline, not executed)`);
        continue;
      }

      await client.query("BEGIN");
      try {
        // The pool sets a statement ceiling so one query cannot hold a
        // connection forever. A migration is a deliberate, one-off backfill:
        // exempt it instead of failing halfway through on a large table.
        await client.query("SET LOCAL statement_timeout = 0");
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
          [migration.filename, digest]
        );
        await client.query("COMMIT");
        result.applied += 1;
        log(`apply   ${migration.filename}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(
          `Migration ${migration.filename} failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    if (result.applied === 0 && result.recorded === 0) {
      log("Database schema is up to date.");
    } else if (baseline) {
      log(
        `Recorded ${result.recorded} migration(s) as applied without executing them.`
      );
    } else {
      log(`Applied ${result.applied} migration(s).`);
    }

    return result;
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_ID])
      .catch(() => undefined);
    client.release();
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  runMigrations({ baseline: process.argv.includes("--baseline") })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => {
      void pool.end();
    });
}
