import "../config/env.js";

import { Pool, types } from "pg";

import { envInt } from "../config/env.js";
import { logger } from "./logger.js";

// The schema uses TIMESTAMP WITHOUT TIME ZONE and stores UTC values. Parse
// those values as UTC so API responses do not shift by the server timezone.
types.setTypeParser(1114, (value: string) => new Date(`${value.replace(" ", "T")}Z`))

/**
 * SSL used to be forced on for every connection, which made the API unable to
 * reach a plain local Postgres (the compose database included): the server
 * answers "The server does not support SSL connections" and the connection
 * fails before any query runs.
 *
 * Rules, in order:
 *   DATABASE_SSL=false   -> never use SSL
 *   DATABASE_SSL=true    -> always use SSL
 *   sslmode=disable      -> never use SSL
 *   sslmode=<anything>   -> use SSL
 *   loopback host        -> no SSL (local development)
 *   anything else        -> SSL, with certificate verification off
 *
 * Verification stays off for remote hosts because that was the previous
 * behaviour; turning it on is tracked as follow-up work.
 */
function resolveSsl(connectionString: string | undefined) {
  const explicit = process.env.DATABASE_SSL?.trim().toLowerCase()

  if (explicit === "false" || explicit === "0") return undefined
  if (explicit === "true" || explicit === "1") return { rejectUnauthorized: false }

  if (!connectionString) return undefined

  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    return undefined
  }

  const sslmode = url.searchParams.get("sslmode")
  if (sslmode === "disable") return undefined
  if (sslmode) return { rejectUnauthorized: false }

  const host = url.hostname
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  ) {
    return undefined
  }

  return { rejectUnauthorized: false }
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
  ssl: resolveSsl(process.env.DATABASE_URL),
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
