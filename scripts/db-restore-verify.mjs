#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import {
  COMPARED_TABLES,
  CONTAINER_MOUNT,
  chooseEngine,
  queryScalar,
  rewriteUrlForEngine,
  runTool,
} from "./pg-cli.mjs";

/**
 * Restore drill: put a dump into an EMPTY database and prove the result works.
 *
 *   node scripts/db-restore-verify.mjs --dump backups/ops.dump \
 *     --url postgres://…/opspilot_restore [--compare postgres://…/opspilot]
 *
 * `--compare` is what turns "the restore exited 0" into evidence: it compares
 * row counts of the tables that matter against the source database. Without it
 * the script still proves the schema loads, the pgvector extension is present
 * and a distance query runs.
 */

function parseArgs(argv) {
  const options = { url: null, dump: null, compare: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--url") options.url = argv[++index];
    else if (arg === "--dump") options.dump = argv[++index];
    else if (arg === "--compare") options.compare = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function fail(message) {
  console.error(`db-restore-verify: ${message}`);
  process.exit(1);
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log(`Usage: node scripts/db-restore-verify.mjs --dump <file> --url <empty-db> [--compare <source-db>]

  --dump      Dump written by scripts/db-backup.mjs
  --url       EMPTY target database; the dump is applied to it
  --compare   Source database whose row counts the target must match`);
  process.exit(0);
}

if (!options.url) fail("--url (the empty target database) is required.");
if (!options.dump) fail("--dump (the file to restore) is required.");
if (!fs.existsSync(options.dump)) fail(`no dump at ${options.dump}`);

const dumpPath = path.resolve(options.dump);
const engine = chooseEngine();
const url = rewriteUrlForEngine(options.url, engine);
const target = engine === "docker" ? `${CONTAINER_MOUNT}/${path.basename(dumpPath)}` : dumpPath;
const mountDir = path.dirname(dumpPath);

// A restore into a non-empty database must not silently merge or fail halfway.
const existing = queryScalar(
  url,
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'",
  { engine }
);

if (existing !== "0") {
  fail(
    `the target database already has ${existing} tables in schema public. Use an empty database.`
  );
}

runTool(
  "pg_restore",
  ["--no-owner", "--no-privileges", "--dbname", url, target],
  { engine, mountDir }
);

const migrations = Number(queryScalar(url, "SELECT count(*) FROM schema_migrations", { engine }));
if (!Number.isFinite(migrations) || migrations === 0) {
  fail("schema_migrations is empty: the dump did not restore the schema ledger");
}

const vectorExtension = queryScalar(
  url,
  "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
  { engine }
);
if (!vectorExtension) {
  fail("the vector extension is not installed in the restored database");
}

// The operator's question is not "did it load", it is "does retrieval still work".
const distance = queryScalar(
  url,
  "SELECT (embedding <=> embedding)::text FROM source_chunks WHERE embedding IS NOT NULL LIMIT 1",
  { engine }
);
if (distance !== "0" && distance !== "") {
  fail(`a pgvector distance query returned an unexpected value: ${distance}`);
}

const counts = {};
for (const table of COMPARED_TABLES) {
  counts[table] = Number(queryScalar(url, `SELECT count(*) FROM ${table}`, { engine }));
}

const report = {
  message: "db.restore.verified",
  engine,
  schemaMigrations: migrations,
  vectorExtension,
  distanceQuery: distance === "0" ? "ok" : "no rows to compare",
  counts,
};

if (options.compare) {
  const sourceUrl = rewriteUrlForEngine(options.compare, engine);
  const mismatches = [];

  for (const table of COMPARED_TABLES) {
    const sourceCount = Number(
      queryScalar(sourceUrl, `SELECT count(*) FROM ${table}`, { engine })
    );

    if (sourceCount !== counts[table]) {
      mismatches.push({ table, source: sourceCount, restored: counts[table] });
    }
  }

  if (mismatches.length > 0) {
    fail(`row counts do not match the source: ${JSON.stringify(mismatches)}`);
  }

  report.comparedWith = new URL(options.compare).pathname.replace(/^\//, "") || "(default)";
  report.countsMatch = true;
}

console.log(JSON.stringify(report));
