import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Regression guard for environment loading order.
 *
 * `config/security.ts` and `core/db.ts` read `process.env` at import time. They
 * used to depend on `core/db.ts` having run `dotenv.config()` first, so any
 * module evaluated earlier captured its constants from an empty environment --
 * `ENABLE_DEV_ENDPOINTS` and `JSON_BODY_LIMIT` from `apps/api/.env` were quietly
 * ignored by the server process.
 *
 * The bug only appears across module evaluation order, which a same-process test
 * cannot reproduce: the module would already be cached. Each check therefore
 * runs a fresh Node process that imports one module as its very first act and
 * prints what it resolved.
 */

const apiRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

/** Environment values that must come from the temp file, not the caller's shell. */
const CONTROLLED_KEYS = [
  "JSON_BODY_LIMIT",
  "ENABLE_DEV_ENDPOINTS",
  "DB_POOL_MAX",
  "HEALTH_DETAIL",
];

function runFirstImport(script: string, envPath: string): Promise<string> {
  const env = { ...process.env };

  for (const key of CONTROLLED_KEYS) {
    delete env[key];
  }

  // Point the loader at the test file instead of the developer's .env.
  env.DOTENV_CONFIG_PATH = envPath;
  env.NODE_ENV = "test";

  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "--eval", script],
      { cwd: apiRoot, env, timeout: 60_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
          return;
        }

        // Only the payload line matters; anything else a dependency prints is
        // noise, not a result.
        const payload = stdout
          .trim()
          .split("\n")
          .filter((line) => line.trim().startsWith("{"))
          .pop();

        if (!payload) {
          reject(new Error(`No JSON payload in output:\n${stdout}\n${stderr}`));
          return;
        }

        resolve(payload);
      }
    );
  });
}

test("config/security sees the env file when it is imported first", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opspilot-env-"));
  const envPath = path.join(dir, ".env");

  fs.writeFileSync(
    envPath,
    "JSON_BODY_LIMIT=2mb\nENABLE_DEV_ENDPOINTS=true\nHEALTH_DETAIL=true\n"
  );

  try {
    const payload = await runFirstImport(
      "import('./src/config/security.js').then(async (m) => console.log(JSON.stringify({" +
        " bodyLimit: m.JSON_BODY_LIMIT," +
        " devEndpoints: m.ENABLE_DEV_ENDPOINTS," +
        " envFileLoaded: (await import('./src/config/env.js')).envFileLoaded" +
        " })))",
      envPath
    );

    assert.deepEqual(JSON.parse(payload), {
      bodyLimit: "2mb",
      devEndpoints: true,
      envFileLoaded: true,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the pool honours its configured bounds", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opspilot-env-"));
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, "DB_POOL_MAX=3\nDB_STATEMENT_TIMEOUT_MS=45000\n");

  try {
    const payload = await runFirstImport(
      "import('./src/core/db.js').then(async (m) => {" +
        " console.log(JSON.stringify({" +
        " max: m.pool.options.max," +
        " connectionTimeoutMillis: m.pool.options.connectionTimeoutMillis," +
        " statementTimeout: m.pool.options.options" +
        " }));" +
        " await m.pool.end();" +
        " })",
      envPath
    );

    const parsed = JSON.parse(payload) as {
      max: number;
      connectionTimeoutMillis: number;
      statementTimeout: string;
    };

    assert.equal(parsed.max, 3);
    assert.equal(parsed.connectionTimeoutMillis, 5000);
    assert.match(parsed.statementTimeout, /statement_timeout=45000/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
