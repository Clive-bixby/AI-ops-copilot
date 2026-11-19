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

const baseline = process.argv.includes("--baseline");

const LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

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

async function main(): Promise<void> {
  const migrations = readMigrations();
  const client = await pool.connect();

  try {
    await client.query(LEDGER_SQL);
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_ID]);

    const ledger = await client.query<{ filename: string; checksum: string }>(
      "SELECT filename, checksum FROM schema_migrations"
    );
    const applied = new Map(
      ledger.rows.map((row) => [row.filename, row.checksum])
    );

    let pending = 0;

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

        console.log(`skip    ${migration.filename} (already applied)`);
        continue;
      }

      pending += 1;

      if (baseline) {
        await client.query(
          "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
          [migration.filename, digest]
        );
        console.log(`record  ${migration.filename} (baseline, not executed)`);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
          [migration.filename, digest]
        );
        await client.query("COMMIT");
        console.log(`apply   ${migration.filename}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(
          `Migration ${migration.filename} failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    if (pending === 0) {
      console.log("Database schema is up to date.");
    } else if (baseline) {
      console.log(
        `Recorded ${pending} migration(s) as applied without executing them.`
      );
    } else {
      console.log(`Applied ${pending} migration(s).`);
    }
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_ID])
      .catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
