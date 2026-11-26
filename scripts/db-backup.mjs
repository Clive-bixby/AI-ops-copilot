#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import {
  CONTAINER_MOUNT,
  chooseEngine,
  rewriteUrlForEngine,
  runTool,
} from "./pg-cli.mjs";

/**
 * Logical backup of an OpsPilot database.
 *
 *   DATABASE_URL=postgres://… node scripts/db-backup.mjs [--out backups/ops.dump]
 *
 * `pg_dump --format=custom` includes the schema, the rows and the pgvector
 * values (they are ordinary columns to the dumper). It does not include roles,
 * ownership or the extension binaries: a restore target needs `vector` to be
 * installable, which Neon, Supabase and the project's own image all provide.
 *
 * The dump is verified before this script reports success. A backup script that
 * trusts an exit status is how an empty file is discovered during an incident.
 */

function parseArgs(argv) {
  const options = { url: process.env.DATABASE_URL, out: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--url") options.url = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function fail(message) {
  console.error(`db-backup: ${message}`);
  process.exit(1);
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log(`Usage: node scripts/db-backup.mjs [--url <postgres-url>] [--out <file>]

  --url   Database to dump (default: DATABASE_URL)
  --out   Dump path (default: backups/opspilot-<timestamp>.dump)`);
  process.exit(0);
}

if (!options.url) {
  fail("no database URL. Pass --url or set DATABASE_URL.");
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const dumpPath = path.resolve(
  options.out ?? path.join("backups", `opspilot-${timestamp}.dump`)
);

if (!dumpPath.endsWith(".dump")) {
  fail("the dump path must end in .dump so the custom format is obvious");
}

fs.mkdirSync(path.dirname(dumpPath), { recursive: true });

const engine = chooseEngine();
const url = rewriteUrlForEngine(options.url, engine);
const fileName = path.basename(dumpPath);
const containerPath = `${CONTAINER_MOUNT}/${fileName}`;
const target = engine === "docker" ? containerPath : dumpPath;

console.log(
  JSON.stringify({
    message: "db.backup.started",
    engine,
    target: dumpPath,
    // The URL is redacted: this output ends up in terminal scrollback and CI logs.
    database: new URL(options.url).pathname.replace(/^\//, "") || "(default)",
  })
);

runTool(
  "pg_dump",
  [
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    `--file=${target}`,
    url,
  ],
  { engine, mountDir: path.dirname(dumpPath) }
);

const stats = fs.statSync(dumpPath);
if (stats.size === 0) {
  fail(`the dump is empty: ${dumpPath}`);
}

const listing = runTool("pg_restore", ["--list", target], {
  engine,
  mountDir: path.dirname(dumpPath),
  capture: true,
});

const objects = listing.split("\n").filter((line) => line && !line.startsWith(";")).length;

if (objects < 10) {
  fail(`the dump lists only ${objects} objects, which cannot be a whole schema`);
}

console.log(
  JSON.stringify({
    message: "db.backup.verified",
    target: dumpPath,
    bytes: stats.size,
    objects,
  })
);
