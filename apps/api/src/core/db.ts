import "../config/env.js";

import { Pool, types } from "pg";

import { envInt } from "../config/env.js";
import { resolveSsl } from "./databaseSsl.js";
import { logger } from "./logger.js";

// The schema uses TIMESTAMP WITHOUT TIME ZONE and stores UTC values. Parse
// those values as UTC so API responses do not shift by the server timezone.
types.setTypeParser(1114, (value: string) => new Date(`${value.replace(" ", "T")}Z`))

/**
 * The TLS decision itself lives in `databaseSsl.ts`, where it has no pool and
 * can be tested. `DATABASE_SSL_CA` turns certificate verification on; without
 * it a remote connection stays encrypted but unverified, which is the previous
 * behaviour and is not silently changed here.
 */
const ssl = resolveSsl({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL,
  caPath: process.env.DATABASE_SSL_CA,
});

// One warning at startup, not one per query: an operator who sees this line has
// a decision to make (supply the provider's CA), and a log that repeats it for
// every connection is a log nobody reads. Loopback and DATABASE_SSL=false never
// reach this branch, so local development stays silent.
if (ssl !== undefined && ssl.rejectUnauthorized === false) {
  logger.warn("db.tls_without_ca", {
    message:
      "The database connection uses TLS without certificate verification. Set DATABASE_SSL_CA to the provider's CA bundle to verify it.",
  });
}

/**
 * The pool is bounded and every wait has a ceiling. An unbounded pool against a
 * managed Postgres (a free tier with a low connection cap) fails with "too many
 * clients" under exactly the load it exists to serve, and a query with no
 * statement timeout holds its connection forever.
 *
 * DB_STATEMENT_TIMEOUT_MS=0 disables the statement ceiling; migrations opt out
 * explicitly so a long backfill is not cut in half.
 */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
  max: envInt("DB_POOL_MAX", 10),
  connectionTimeoutMillis: envInt("DB_CONNECTION_TIMEOUT_MS", 5_000),
  idleTimeoutMillis: envInt("DB_IDLE_TIMEOUT_MS", 30_000),
  options: `-c statement_timeout=${envInt("DB_STATEMENT_TIMEOUT_MS", 30_000)}`,
  application_name: "opspilot-api",
})

/**
 * A client dropped while idle is normal, not fatal: Postgres restarts, a
 * managed database scales to zero, a network path is reset. node-postgres
 * removes the client and the next query opens a new one -- but an `error` event
 * with no listener is an uncaught exception, so the process used to exit on the
 * first such blip. This listener must never rethrow.
 */
pool.on("error", (error) => {
  logger.error("db.idle_client_error", { error })
})
