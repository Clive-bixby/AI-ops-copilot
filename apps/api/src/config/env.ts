import dotenv from "dotenv";

/**
 * The only module that loads `.env`.
 *
 * Loading used to happen in `core/db.ts`, so any module evaluated earlier read
 * `process.env` before the file was applied. `index.ts` imports
 * `config/security.ts` before `app.ts` (and therefore before `db.ts`), which
 * meant `JSON_BODY_LIMIT` and `ENABLE_DEV_ENDPOINTS` from `apps/api/.env` were
 * frozen at their fallbacks for the whole process. Setting either value in the
 * file had no effect and nothing said so.
 *
 * Every module that reads an environment value at import time imports this one,
 * so the fix does not depend on remembering a particular import order.
 *
 * `DOTENV_CONFIG_PATH` overrides the file, which lets a test point at its own
 * temporary file instead of the developer's.
 */
const loaded = dotenv.config({
  ...(process.env.DOTENV_CONFIG_PATH ? { path: process.env.DOTENV_CONFIG_PATH } : {}),
  // dotenv prints an advertising tip on every load; production logs are JSON
  // lines and should not contain it.
  quiet: true,
});

/** False when no env file was found (a container normally has real env vars). */
export const envFileLoaded = !("error" in loaded);

/**
 * A test process must never be able to reach the database named in `.env`.
 *
 * Every integration suite truncates tables, and `.env` in this repository
 * points at a deployed database. Setting `TEST_DATABASE_URL` used to be enough
 * only if the harness happened to be imported before any module that builds a
 * pool; one static `import { runIngestionJob }` evaluated `core/db.ts` first and
 * the suite truncated the deployed database instead of the disposable one.
 *
 * This file is the only place that loads `.env` and every module that reads the
 * environment at import time imports it, so the override belongs here: it does
 * not depend on import order. Production is untouched (no `TEST_DATABASE_URL`),
 * and `NODE_ENV=production` is refused outright.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (testDatabaseUrl && process.env.NODE_ENV !== "production") {
  process.env.DATABASE_URL = testDatabaseUrl;
}

/** Integer from the environment, with the fallback used for missing/invalid. */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 0) {
    console.warn(`Invalid ${name}; using ${fallback}.`, { value: raw });
    return fallback;
  }

  return parsed;
}

const TRUE_VALUES = ["1", "true", "yes", "on"];
const FALSE_VALUES = ["0", "false", "no", "off"];

/** Boolean from the environment, with the fallback used for missing/invalid. */
export function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = raw.trim().toLowerCase();

  if (TRUE_VALUES.includes(value)) return true;
  if (FALSE_VALUES.includes(value)) return false;

  console.warn(`Invalid ${name}; using ${fallback}.`, { value: raw });
  return fallback;
}
